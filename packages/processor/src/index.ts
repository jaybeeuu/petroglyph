import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { DynamoDBTokenStore, OAuthTokenResolver } from "@petroglyph/core";
import type { TokenRequestOutcome } from "@petroglyph/core";
import { z } from "zod";

const ONEDRIVE_PROVIDER = "onedrive";

let cachedS3Client: S3Client | undefined;

/**
 * The S3 client, built on first use. Building it at module scope would make
 * importing this module an effect (petroglyph-1o2d).
 */
function s3Client(): S3Client {
  cachedS3Client ??= new S3Client({});
  return cachedS3Client;
}

let cachedDocClient: DynamoDBDocumentClient | undefined;

/**
 * The document client, built on first use (petroglyph-1o2d).
 */
function docClient(): DynamoDBDocumentClient {
  cachedDocClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedDocClient;
}

const parentReferenceSchema = z.object({
  driveId: z.string().min(1),
  path: z.string().min(1),
});

const driveFileSchema = z.object({
  mimeType: z.string().min(1).optional(),
});

const driveFolderSchema = z.object({
  childCount: z.number().int().nonnegative().optional(),
});

export const ingestQueueMessageSchema = z.object({
  fileId: z.string().min(1),
  profileId: z.string().min(1),
  /**
   * The connection the file belongs to. The token vault is keyed (userId,
   * provider), so the processor cannot resolve a grant without it.
   */
  userId: z.string().min(1),
  itemMetadata: z.object({
    id: z.string().min(1),
    odataType: z.string().min(1),
    name: z.string().min(1).optional(),
    webUrl: z.url().optional(),
    resource: z.string().min(1),
    parentReference: parentReferenceSchema.optional(),
  }),
});

const driveItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  webUrl: z.url().optional(),
  parentReference: parentReferenceSchema.optional(),
  file: driveFileSchema.optional(),
  folder: driveFolderSchema.optional(),
});

/**
 * The Microsoft token endpoint's success payload. The refresh request itself
 * stays here because core's resolver takes the transport as a callback; core
 * owns the rotation, the CAS write and the sticky reconnect flag.
 */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const tokenErrorSchema = z.object({ error: z.string().min(1) });

type GraphDriveItem = z.infer<typeof driveItemSchema>;
type IngestQueueMessage = z.infer<typeof ingestQueueMessageSchema>;

function tokenVaultsTableName(): string {
  return process.env["TOKEN_VAULTS_TABLE"] ?? "petroglyph-token-vaults-default";
}

function stagedBucketName(): string {
  const bucketName = process.env["STAGED_PDFS_BUCKET"];
  if (!bucketName) {
    throw new Error("STAGED_PDFS_BUCKET env var not set");
  }

  return bucketName;
}

function fileRecordsTableName(): string {
  return process.env["FILE_RECORDS_TABLE"] ?? "petroglyph-file-records-default";
}

function stagedPdfPrefix(): string {
  const prefix = process.env["STAGED_PDF_PREFIX"] ?? "handwritten";
  return prefix.replace(/^\/+|\/+$/g, "");
}

function extractOneDriveParentPath(parentPath: string): string[] {
  const rootMarker = "root:";
  const rootIndex = parentPath.indexOf(rootMarker);

  if (rootIndex === -1) {
    throw new Error(`Invalid OneDrive parentReference.path: ${parentPath}`);
  }

  const relativePath = parentPath.slice(rootIndex + rootMarker.length).replace(/^\/+|\/+$/g, "");

  return relativePath.length > 0 ? relativePath.split("/") : [];
}

function buildS3Key(filename: string, parentPath: string): string {
  return [stagedPdfPrefix(), ...extractOneDriveParentPath(parentPath), filename].join("/");
}

/**
 * The only place this Lambda speaks OAuth to Microsoft. Core's resolver owns the
 * rotation: a successful answer is a CAS write on the vault row the adapter
 * reads, and a dead grant persists `reconnectRequired` instead of a new token.
 */
async function requestMicrosoftTokens(refreshToken: string): Promise<TokenRequestOutcome> {
  const clientId = process.env["MICROSOFT_CLIENT_ID"];
  if (!clientId) {
    throw new Error("MICROSOFT_CLIENT_ID env var not set");
  }
  const clientSecret = process.env["MICROSOFT_CLIENT_SECRET"];
  if (!clientSecret) {
    throw new Error("MICROSOFT_CLIENT_SECRET env var not set");
  }

  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "files.readwrite offline_access",
    }).toString(),
  });

  const body: unknown = await response.json();

  if (!response.ok) {
    const failure = tokenErrorSchema.safeParse(body);
    if (failure.success && failure.data.error === "invalid_grant") {
      return { kind: "grant-invalid" };
    }
    throw new Error(`Microsoft token refresh failed: ${response.status} ${response.statusText}`);
  }

  const tokens = tokenResponseSchema.parse(body);
  return {
    kind: "success",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  };
}

let cachedTokenResolver: OAuthTokenResolver | undefined;

/**
 * The connection-keyed resolver over the token vault — the store the OneDrive
 * adapter also reads, so a rotation here is the token the adapter next sends.
 */
function tokenResolver(): OAuthTokenResolver {
  cachedTokenResolver ??= new OAuthTokenResolver({
    store: new DynamoDBTokenStore({ client: docClient(), tableName: tokenVaultsTableName() }),
    now: () => Math.floor(Date.now() / 1000),
    requestTokens: requestMicrosoftTokens,
  });
  return cachedTokenResolver;
}

async function resolveOneDriveAccessToken(userId: string): Promise<string> {
  const outcome = await tokenResolver().resolveAccessToken(userId, ONEDRIVE_PROVIDER);
  if (outcome.kind !== "success") {
    throw new Error(`OneDrive grant for user ${userId} requires reconnect`);
  }
  return outcome.accessToken;
}

async function fetchDriveItem(resource: string, accessToken: string): Promise<GraphDriveItem> {
  const response = await fetch(`https://graph.microsoft.com/v1.0/${resource}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Graph drive item fetch failed: ${response.status} ${response.statusText}`);
  }

  return driveItemSchema.parse(await response.json());
}

async function resolveDriveItem(
  message: IngestQueueMessage,
  accessToken: string,
): Promise<GraphDriveItem> {
  return fetchDriveItem(message.itemMetadata.resource, accessToken);
}

function isPdfDriveItem(driveItem: GraphDriveItem): boolean {
  if (driveItem.folder !== undefined || driveItem.file === undefined) {
    return false;
  }

  return (
    driveItem.file.mimeType === "application/pdf" || driveItem.name.toLowerCase().endsWith(".pdf")
  );
}

async function downloadPdf(resource: string, accessToken: string): Promise<Uint8Array> {
  const response = await fetch(`https://graph.microsoft.com/v1.0/${resource}/content`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Graph PDF download failed: ${response.status} ${response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function writeFileRecord(
  message: IngestQueueMessage,
  filename: string,
  s3Key: string,
): Promise<void> {
  await docClient().send(
    new PutCommand({
      TableName: fileRecordsTableName(),
      Item: {
        profileId: message.profileId,
        fileId: message.fileId,
        filename,
        s3Key,
        createdAt: new Date().toISOString(),
        status: "staged",
      },
    }),
  );
}

async function processRecord(record: SQSRecord): Promise<void> {
  const message = ingestQueueMessageSchema.parse(JSON.parse(record.body) as unknown);
  const accessToken = await resolveOneDriveAccessToken(message.userId);
  const driveItem = await resolveDriveItem(message, accessToken);

  if (!isPdfDriveItem(driveItem)) {
    console.warn("[processor] skipping non-PDF drive item", {
      fileId: message.fileId,
      name: driveItem.name,
    });
    return;
  }

  const parentPath = driveItem.parentReference?.path;
  if (!parentPath) {
    throw new Error(`Drive item missing parentReference.path: ${driveItem.id}`);
  }

  const filename = driveItem.name;
  const s3Key = buildS3Key(filename, parentPath);
  const pdfBytes = await downloadPdf(message.itemMetadata.resource, accessToken);

  await s3Client().send(
    new PutObjectCommand({
      Bucket: stagedBucketName(),
      Key: s3Key,
      Body: pdfBytes,
      ContentType: "application/pdf",
    }),
  );

  await writeFileRecord(message, filename, s3Key);
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error("[processor] failed to process record:", error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

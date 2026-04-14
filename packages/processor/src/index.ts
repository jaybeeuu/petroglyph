import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { z } from "zod";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const SSM_ACCESS_TOKEN = "/petroglyph/onedrive/access-token";
const SSM_TOKEN_EXPIRY = "/petroglyph/onedrive/token-expiry";
const SSM_REFRESH_TOKEN = "/petroglyph/onedrive/refresh-token";

const s3Client = new S3Client({});
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssmClient = new SSMClient({});

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

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
});

type GraphDriveItem = z.infer<typeof driveItemSchema>;
type IngestQueueMessage = z.infer<typeof ingestQueueMessageSchema>;

interface OneDriveParams {
  accessToken: string;
  tokenExpiry: string;
  refreshToken: string;
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

async function readSsmString(name: string): Promise<string> {
  const result = await ssmClient.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  const value = result.Parameter?.Value;

  if (!value) {
    throw new Error(`SSM parameter not found or empty: ${name}`);
  }

  return value;
}

async function readOneDriveParams(): Promise<OneDriveParams> {
  const [accessToken, tokenExpiry, refreshToken] = await Promise.all([
    readSsmString(SSM_ACCESS_TOKEN),
    readSsmString(SSM_TOKEN_EXPIRY),
    readSsmString(SSM_REFRESH_TOKEN),
  ]);

  return { accessToken, tokenExpiry, refreshToken };
}

async function persistRefreshedTokens(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): Promise<void> {
  const tokenExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();

  await Promise.all([
    ssmClient.send(
      new PutParameterCommand({
        Name: SSM_ACCESS_TOKEN,
        Value: accessToken,
        Type: "SecureString",
        Overwrite: true,
      }),
    ),
    ssmClient.send(
      new PutParameterCommand({
        Name: SSM_TOKEN_EXPIRY,
        Value: tokenExpiry,
        Type: "SecureString",
        Overwrite: true,
      }),
    ),
    ssmClient.send(
      new PutParameterCommand({
        Name: SSM_REFRESH_TOKEN,
        Value: refreshToken,
        Type: "SecureString",
        Overwrite: true,
      }),
    ),
  ]);
}

async function refreshOneDriveAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env["MICROSOFT_CLIENT_ID"];
  if (!clientId) {
    throw new Error("MICROSOFT_CLIENT_ID env var not set");
  }

  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "files.read offline_access",
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Microsoft token refresh failed: ${response.status} ${response.statusText}`);
  }

  const parsedResponse = tokenResponseSchema.parse(await response.json());

  await persistRefreshedTokens(
    parsedResponse.access_token,
    parsedResponse.refresh_token,
    parsedResponse.expires_in,
  );

  return parsedResponse.access_token;
}

async function resolveOneDriveAccessToken(): Promise<string> {
  const params = await readOneDriveParams();
  const millisecondsUntilExpiry = new Date(params.tokenExpiry).getTime() - Date.now();

  if (millisecondsUntilExpiry > TEN_MINUTES_MS) {
    return params.accessToken;
  }

  return refreshOneDriveAccessToken(params.refreshToken);
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
  await docClient.send(
    new PutCommand({
      TableName: fileRecordsTableName(),
      Item: {
        profileId: message.profileId,
        fileId: message.fileId,
        filename,
        s3Key,
        createdAt: new Date().toISOString(),
        status: "pending",
      },
    }),
  );
}

async function processRecord(record: SQSRecord): Promise<void> {
  const message = ingestQueueMessageSchema.parse(JSON.parse(record.body) as unknown);
  const accessToken = await resolveOneDriveAccessToken();
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

  await s3Client.send(
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

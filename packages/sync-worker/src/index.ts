import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { DynamoDBTokenStore, OAuthTokenResolver } from "@petroglyph/core";
import type { TokenRequestOutcome } from "@petroglyph/core";
import { z } from "zod";
import { docClient } from "./db.js";

const ONEDRIVE_PROVIDER = "onedrive";

// TTL durations for sync_jobs records, in epoch seconds (DynamoDB TTL expects
// seconds since epoch). queued jobs are chopped by TTL after 5 minutes as the
// failure detector + retry trigger; the relay re-creates them on REMOVE.
const RUNNING_JOB_TTL_SECONDS = 2 * 60 * 60;
const COMPLETED_JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const FAILED_JOB_TTL_SECONDS = 90 * 24 * 60 * 60;

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

let cachedSqsClient: SQSClient | undefined;

/**
 * The SQS client, built on first use. Building it at module scope would make
 * importing this module an effect (petroglyph-1o2d).
 */
function sqsClient(): SQSClient {
  cachedSqsClient ??= new SQSClient({});
  return cachedSqsClient;
}

function fileRecordsTableName(): string {
  return process.env["FILE_RECORDS_TABLE"] ?? "petroglyph-file-records-default";
}

function deltaTokensTableName(): string {
  return process.env["DELTA_TOKENS_TABLE"] ?? "petroglyph-delta-tokens-default";
}

function syncJobsTableName(): string {
  return process.env["SYNC_JOBS_TABLE"] ?? "petroglyph-sync-jobs-default";
}

function tokenVaultsTableName(): string {
  return process.env["TOKEN_VAULTS_TABLE"] ?? "petroglyph-token-vaults-default";
}

function ingestQueueUrl(): string {
  const url = process.env["INGEST_QUEUE_URL"];
  if (!url) {
    throw new Error("INGEST_QUEUE_URL env var not set");
  }
  return url;
}

/**
 * The Microsoft token endpoint's payloads. The request itself stays here because
 * core's resolver takes the transport as a callback; core owns the rotation, the
 * CAS write and the sticky reconnect flag.
 */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const tokenErrorSchema = z.object({ error: z.string().min(1) });

export const syncJobMessageSchema = z.object({
  jobId: z.string().min(1),
  profileId: z.string().min(1),
  sourceFolderPath: z.string().min(1),
  userId: z.string().min(1),
});

type SyncJobMessage = z.infer<typeof syncJobMessageSchema>;

interface GraphDeltaPage {
  value: unknown[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface GraphDriveFileItem {
  id: string;
  name: string;
  odataType: string;
  webUrl: string | undefined;
  parentReference: { driveId: string; path: string } | undefined;
}

interface UnknownRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function readDeltaToken(profileId: string): Promise<string | undefined> {
  try {
    const result = await docClient().send(
      new GetCommand({
        TableName: deltaTokensTableName(),
        Key: { profileId },
      }),
    );
    const deltaToken: unknown = result.Item?.["deltaToken"];
    return typeof deltaToken === "string" ? deltaToken : undefined;
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException") {
      return undefined;
    }
    throw error;
  }
}

function buildDeltaUrl(folder: string, deltaToken?: string): string {
  const url = new URL(
    `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURI(folder)}:/delta`,
  );
  if (deltaToken) {
    url.searchParams.set("token", deltaToken);
  }
  return url.toString();
}

function parseGraphDeltaPage(value: unknown): GraphDeltaPage {
  if (!isRecord(value) || !Array.isArray(value["value"])) {
    throw new Error("Invalid Graph delta response");
  }

  const nextLink = value["@odata.nextLink"];
  const deltaLink = value["@odata.deltaLink"];

  return {
    value: value["value"],
    ...(typeof nextLink === "string" && { "@odata.nextLink": nextLink }),
    ...(typeof deltaLink === "string" && { "@odata.deltaLink": deltaLink }),
  };
}

function parseGraphDriveFileItem(value: unknown): GraphDriveFileItem | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value["deleted"] !== undefined) {
    return null;
  }

  if (typeof value["id"] !== "string" || typeof value["name"] !== "string") {
    return null;
  }

  if (!isRecord(value["file"])) {
    return null;
  }

  const mimeType = value["file"]["mimeType"];
  const filename = value["name"];
  const isPdf = mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    return null;
  }

  const odataType =
    typeof value["@odata.type"] === "string" ? value["@odata.type"] : "#microsoft.graph.driveItem";
  const webUrl = typeof value["webUrl"] === "string" ? value["webUrl"] : undefined;
  const parentReference = isRecord(value["parentReference"])
    ? {
        driveId:
          typeof value["parentReference"]["driveId"] === "string"
            ? value["parentReference"]["driveId"]
            : "",
        path:
          typeof value["parentReference"]["path"] === "string"
            ? value["parentReference"]["path"]
            : "",
      }
    : undefined;

  return {
    id: value["id"],
    name: filename,
    odataType,
    webUrl,
    parentReference,
  };
}

function extractDeltaToken(deltaLink: string): string {
  const url = new URL(deltaLink);
  return url.searchParams.get("token") ?? deltaLink;
}

async function fetchDeltaPage(url: string, accessToken: string): Promise<GraphDeltaPage> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Graph delta request failed with status ${response.status}`);
  }

  return parseGraphDeltaPage(await response.json());
}

async function writeFileRecord(
  file: GraphDriveFileItem,
  createdAt: string,
  profileId: string,
): Promise<void> {
  await docClient().send(
    new PutCommand({
      TableName: fileRecordsTableName(),
      Item: {
        profileId,
        fileId: file.id,
        s3Key: "",
        filename: file.name,
        createdAt,
        status: "pending",
      },
    }),
  );
}

async function sendIngestMessage(
  file: GraphDriveFileItem,
  profileId: string,
  userId: string,
): Promise<void> {
  const message = {
    fileId: file.id,
    profileId,
    userId,
    itemMetadata: {
      id: file.id,
      odataType: file.odataType,
      name: file.name,
      webUrl: file.webUrl,
      resource: `me/drive/items/${file.id}`,
      parentReference: file.parentReference,
    },
  };

  await sqsClient().send(
    new SendMessageCommand({
      QueueUrl: ingestQueueUrl(),
      MessageBody: JSON.stringify(message),
    }),
  );
}

async function storeDeltaToken(profileId: string, deltaToken: string): Promise<void> {
  await docClient().send(
    new PutCommand({
      TableName: deltaTokensTableName(),
      Item: {
        profileId,
        deltaToken,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

async function updateSyncJobStatus(
  jobId: string,
  status: "completed" | "failed",
  metadata?: { fileCount?: number; errorMessage?: string },
): Promise<void> {
  const updateExpression =
    status === "completed"
      ? "SET #status = :status, fileCount = :fileCount, updatedAt = :updatedAt, expiresAt = :expiresAt"
      : "SET #status = :status, errorMessage = :errorMessage, updatedAt = :updatedAt, expiresAt = :expiresAt";

  const expressionAttributeValues: { [key: string]: unknown } = {
    ":status": status,
    ":updatedAt": new Date().toISOString(),
    ":expiresAt":
      nowEpochSeconds() +
      (status === "completed" ? COMPLETED_JOB_TTL_SECONDS : FAILED_JOB_TTL_SECONDS),
  };

  if (status === "completed" && metadata?.fileCount !== undefined) {
    expressionAttributeValues[":fileCount"] = metadata.fileCount;
  } else if (status === "failed" && metadata?.errorMessage !== undefined) {
    expressionAttributeValues[":errorMessage"] = metadata.errorMessage;
  }

  await docClient().send(
    new UpdateCommand({
      TableName: syncJobsTableName(),
      Key: { jobId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: expressionAttributeValues,
    }),
  );
}

async function processSyncJob(message: SyncJobMessage): Promise<number> {
  const accessToken = await resolveOneDriveAccessToken(message.userId);
  const startingDeltaToken = await readDeltaToken(message.profileId);

  let nextUrl: string | undefined = buildDeltaUrl(message.sourceFolderPath, startingDeltaToken);
  let latestDeltaToken: string | undefined;
  let queued = 0;

  while (nextUrl) {
    const page = await fetchDeltaPage(nextUrl, accessToken);
    const createdAt = new Date().toISOString();

    for (const item of page.value) {
      const file = parseGraphDriveFileItem(item);
      if (!file) {
        continue;
      }

      await writeFileRecord(file, createdAt, message.profileId);
      await sendIngestMessage(file, message.profileId, message.userId);
      queued += 1;
    }

    nextUrl = page["@odata.nextLink"];
    if (page["@odata.deltaLink"]) {
      latestDeltaToken = extractDeltaToken(page["@odata.deltaLink"]);
    }
  }

  if (latestDeltaToken) {
    await storeDeltaToken(message.profileId, latestDeltaToken);
  }

  return queued;
}

async function claimSyncJob(jobId: string): Promise<boolean> {
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: syncJobsTableName(),
        Key: { jobId },
        UpdateExpression: "SET #status = :status, startedAt = :startedAt, expiresAt = :expiresAt",
        ConditionExpression: "#status = :queued OR #status = :failed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "running",
          ":queued": "queued",
          ":failed": "failed",
          ":startedAt": new Date().toISOString(),
          ":expiresAt": nowEpochSeconds() + RUNNING_JOB_TTL_SECONDS,
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw error;
  }
}

async function handleRecord(record: SQSRecord): Promise<void> {
  const message = syncJobMessageSchema.parse(JSON.parse(record.body) as unknown);

  const claimed = await claimSyncJob(message.jobId);
  if (!claimed) {
    // At-least-once delivery (SQS redrive + outbox stream) can re-deliver a
    // message for a job that is already running or completed. The record is
    // the source of truth, so consume the duplicate without re-processing.
    console.warn(
      `[sync-worker] skipping job ${message.jobId}: record is already running/completed`,
    );
    return;
  }

  try {
    const fileCount = await processSyncJob(message);
    await updateSyncJobStatus(message.jobId, "completed", { fileCount });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await updateSyncJobStatus(message.jobId, "failed", { errorMessage });
    throw error;
  }
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      await handleRecord(record);
    } catch (error) {
      console.error("[sync-worker] failed to process record:", error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

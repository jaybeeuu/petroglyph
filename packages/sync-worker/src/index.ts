import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { docClient } from "./db.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;

const sqsClient = new SQSClient({});

function fileRecordsTableName(): string {
  return process.env["FILE_RECORDS_TABLE"] ?? "petroglyph-file-records-default";
}

function deltaTokensTableName(): string {
  return process.env["DELTA_TOKENS_TABLE"] ?? "petroglyph-delta-tokens-default";
}

function syncJobsTableName(): string {
  return process.env["SYNC_JOBS_TABLE"] ?? "petroglyph-sync-jobs-default";
}

function ingestQueueUrl(): string {
  const url = process.env["INGEST_QUEUE_URL"];
  if (!url) {
    throw new Error("INGEST_QUEUE_URL env var not set");
  }
  return url;
}

function refreshTokensTableName(): string {
  return process.env["REFRESH_TOKENS_TABLE"] ?? "petroglyph-refresh-tokens-default";
}

interface SyncJobMessage {
  jobId: string;
  profileId: string;
  sourceFolderPath: string;
  userId: string;
}

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

interface OneDriveTokens {
  accessToken: string;
  refreshToken: string;
  expirySeconds: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOneDriveTokens(userId: string): Promise<OneDriveTokens> {
  const result = await docClient.send(
    new GetCommand({
      TableName: refreshTokensTableName(),
      Key: { tokenHash: userId },
    }),
  );

  const item = result.Item;
  if (!item || typeof item !== "object") {
    throw new Error(`OneDrive token record missing for user ${userId}`);
  }

  const record = item as { [key: string]: unknown };
  const accessToken = record["accessToken"];
  const refreshToken = record["refreshToken"];
  const expirySeconds = record["expirySeconds"];

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error(`OneDrive accessToken missing for user ${userId}`);
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error(`OneDrive refreshToken missing for user ${userId}`);
  }
  if (typeof expirySeconds !== "number") {
    throw new Error(`OneDrive expirySeconds missing for user ${userId}`);
  }

  return { accessToken, refreshToken, expirySeconds };
}

async function refreshOneDriveAccessToken(userId: string, refreshToken: string): Promise<string> {
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
      scope: "files.readwrite offline_access",
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Microsoft token refresh failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expirySeconds = Math.floor(Date.now() / 1000) + data.expires_in;
  await docClient.send(
    new UpdateCommand({
      TableName: refreshTokensTableName(),
      Key: { tokenHash: userId },
      UpdateExpression:
        "SET accessToken = :accessToken, refreshToken = :refreshToken, expirySeconds = :expirySeconds, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":accessToken": data.access_token,
        ":refreshToken": data.refresh_token,
        ":expirySeconds": expirySeconds,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );

  return data.access_token;
}

async function resolveOneDriveAccessToken(userId: string): Promise<string> {
  const tokens = await readOneDriveTokens(userId);
  const millisecondsUntilExpiry = tokens.expirySeconds * 1000 - Date.now();

  if (millisecondsUntilExpiry > TEN_MINUTES_MS) {
    return tokens.accessToken;
  }

  return refreshOneDriveAccessToken(userId, tokens.refreshToken);
}

async function readDeltaToken(profileId: string): Promise<string | undefined> {
  try {
    const result = await docClient.send(
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
  await docClient.send(
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

async function sendIngestMessage(file: GraphDriveFileItem, profileId: string): Promise<void> {
  const message = {
    fileId: file.id,
    profileId,
    itemMetadata: {
      id: file.id,
      odataType: file.odataType,
      name: file.name,
      webUrl: file.webUrl,
      resource: `me/drive/items/${file.id}`,
      parentReference: file.parentReference,
    },
  };

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: ingestQueueUrl(),
      MessageBody: JSON.stringify(message),
    }),
  );
}

async function storeDeltaToken(profileId: string, deltaToken: string): Promise<void> {
  await docClient.send(
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
      ? "SET #status = :status, fileCount = :fileCount, updatedAt = :updatedAt"
      : "SET #status = :status, errorMessage = :errorMessage, updatedAt = :updatedAt";

  const expressionAttributeValues: { [key: string]: unknown } = {
    ":status": status,
    ":updatedAt": new Date().toISOString(),
  };

  if (status === "completed" && metadata?.fileCount !== undefined) {
    expressionAttributeValues[":fileCount"] = metadata.fileCount;
  } else if (status === "failed" && metadata?.errorMessage !== undefined) {
    expressionAttributeValues[":errorMessage"] = metadata.errorMessage;
  }

  await docClient.send(
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
      await sendIngestMessage(file, message.profileId);
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
    await docClient.send(
      new UpdateCommand({
        TableName: syncJobsTableName(),
        Key: { jobId },
        UpdateExpression: "SET #status = :status, startedAt = :startedAt",
        ConditionExpression: "#status = :queued OR #status = :failed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "running",
          ":queued": "queued",
          ":failed": "failed",
          ":startedAt": new Date().toISOString(),
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
  const message = JSON.parse(record.body) as SyncJobMessage;

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

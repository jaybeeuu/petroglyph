import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type {
  AttributeValue,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from "aws-lambda";
import { docClient } from "./db.js";

const sqsClient = new SQSClient({});

// A TTL deletion is the only REMOVE whose userIdentity identifies the DynamoDB
// TTL process; regular deletes carry no userIdentity at all.
const TTL_DELETION_PRINCIPAL_ID = "dynamodb.amazonaws.com";
const QUEUED_JOB_TTL_SECONDS = 5 * 60;
// A job is re-created on TTL removal up to this many times, then dropped.
const MAX_JOB_RETRY_COUNT = 5;

function syncJobQueueUrl(): string {
  const url = process.env["SYNC_JOB_QUEUE_URL"];
  if (!url) {
    throw new Error("SYNC_JOB_QUEUE_URL env var not set");
  }
  return url;
}

function syncJobsTableName(): string {
  return process.env["SYNC_JOBS_TABLE"] ?? "petroglyph-sync-jobs-default";
}

interface SyncJobMessage {
  jobId: string;
  profileId: string;
  sourceFolderPath: string;
  userId: string;
}

function stringValue(value: AttributeValue | undefined): string | undefined {
  if (value && typeof value === "object" && "S" in value && typeof value["S"] === "string") {
    return value["S"];
  }
  return undefined;
}

function numberValue(value: AttributeValue | undefined): number | undefined {
  if (value && typeof value === "object" && "N" in value && typeof value["N"] === "string") {
    return Number(value["N"]);
  }
  return undefined;
}

function parseQueuedJob(newImage: { [key: string]: AttributeValue }): SyncJobMessage | null {
  const jobId = stringValue(newImage["jobId"]);
  const profileId = stringValue(newImage["profileId"]);
  const sourceFolderPath = stringValue(newImage["sourceFolderPath"]);
  const userId = stringValue(newImage["userId"]);
  const status = stringValue(newImage["status"]);

  if (!jobId || !profileId || !sourceFolderPath || !userId || status !== "queued") {
    return null;
  }

  return { jobId, profileId, sourceFolderPath, userId };
}

interface RemovedJob extends SyncJobMessage {
  retryCount: number;
}

function parseRemovedJob(newImage: { [key: string]: AttributeValue }): RemovedJob | null {
  const jobId = stringValue(newImage["jobId"]);
  const profileId = stringValue(newImage["profileId"]);
  const sourceFolderPath = stringValue(newImage["sourceFolderPath"]);
  const userId = stringValue(newImage["userId"]);

  if (!jobId || !profileId || !sourceFolderPath || !userId) {
    return null;
  }

  return {
    jobId,
    profileId,
    sourceFolderPath,
    userId,
    retryCount: numberValue(newImage["retryCount"]) ?? 0,
  };
}

function isTtlRemoval(record: DynamoDBRecord): boolean {
  if (record.eventName !== "REMOVE") {
    return false;
  }
  const userIdentity: unknown = record.userIdentity;
  if (typeof userIdentity !== "object" || userIdentity === null) {
    return false;
  }
  return (userIdentity as { [key: string]: unknown })["principalId"] === TTL_DELETION_PRINCIPAL_ID;
}

// A TTL removal of a queued job is the failure-detector signal: the job was
// stuck (never picked up), so re-create it with a fresh TTL window. The
// re-created record emits a new INSERT, which re-dispatches through the relay.
// Other statuses are never re-created: running is ambiguous (double-run risk)
// and completed/failed have their own retention windows.
async function recreateQueuedJob(job: RemovedJob): Promise<void> {
  if (job.retryCount >= MAX_JOB_RETRY_COUNT) {
    console.warn(
      `[sync-relay] dropping job ${job.jobId}: retryCount ${job.retryCount} reached the cap of ${MAX_JOB_RETRY_COUNT}`,
    );
    return;
  }

  const createdAt = new Date().toISOString();
  await docClient.send(
    new PutCommand({
      TableName: syncJobsTableName(),
      Item: {
        jobId: job.jobId,
        userId: job.userId,
        profileId: job.profileId,
        sourceFolderPath: job.sourceFolderPath,
        status: "queued",
        createdAt,
        expiresAt: Math.floor(new Date(createdAt).getTime() / 1000) + QUEUED_JOB_TTL_SECONDS,
        retryCount: job.retryCount + 1,
      },
    }),
  );
}

async function relayJob(record: DynamoDBRecord): Promise<void> {
  if (isTtlRemoval(record)) {
    // With stream_view_type=NEW_IMAGE, a TTL REMOVE record carries the
    // pre-deletion item in NewImage (regular deletes have no item image).
    const newImage = record.dynamodb?.NewImage;
    if (!newImage) {
      return;
    }

    const removedJob = parseRemovedJob(newImage);
    if (!removedJob) {
      console.warn("[sync-relay] skipping TTL removal with missing or invalid job fields");
      return;
    }

    // TTL deletions of running/completed/failed records are routine cleanup:
    // running is ambiguous (double-run risk), the others have their own
    // retention windows. Only a queued job is re-created.
    if (stringValue(newImage["status"]) !== "queued") {
      return;
    }

    await recreateQueuedJob(removedJob);
    return;
  }

  if (record.eventName !== "INSERT") {
    return;
  }

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) {
    return;
  }

  const message = parseQueuedJob(newImage);
  if (!message) {
    console.warn("[sync-relay] skipping record with missing or invalid job fields");
    return;
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: syncJobQueueUrl(),
      MessageBody: JSON.stringify(message),
    }),
  );
}

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const batchItemFailures: DynamoDBBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      await relayJob(record);
    } catch (error) {
      console.error("[sync-relay] failed to relay record:", error);
      const sequenceNumber = record.dynamodb?.SequenceNumber;
      if (sequenceNumber) {
        batchItemFailures.push({ itemIdentifier: sequenceNumber });
      }
    }
  }

  return { batchItemFailures };
};

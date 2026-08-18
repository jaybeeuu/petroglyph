import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type {
  AttributeValue,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from "aws-lambda";

const sqsClient = new SQSClient({});

function syncJobQueueUrl(): string {
  const url = process.env["SYNC_JOB_QUEUE_URL"];
  if (!url) {
    throw new Error("SYNC_JOB_QUEUE_URL env var not set");
  }
  return url;
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

async function relayJob(record: DynamoDBRecord): Promise<void> {
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

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { DynamoDBStagedIndexStore, S3StagedObjectStore } from "@petroglyph/staging-contracts";
import { z } from "zod";
import { purgeStagedStorageForProfile, type PurgeOutcome } from "./profile-purge.js";

/**
 * The parts of a profiles-stream image the janitor reads. A stream record is
 * external input, so the image is checked rather than trusted.
 */
const profileImageSchema = z.looseObject({
  profileId: z.object({ S: z.string().min(1) }),
  deletedAt: z.object({ S: z.string().min(1) }).optional(),
});

const deletedProfileImageSchema = z.looseObject({
  profileId: z.object({ S: z.string().min(1) }),
  deletedAt: z.object({ S: z.string().min(1) }),
});

/**
 * The profileId of a deletion transition, or undefined for a record that must
 * not start a purge.
 *
 * The transition is `NewImage.deletedAt` present and `OldImage.deletedAt`
 * absent. That excludes a rename or an edit (no deletedAt at all) and a later
 * change to an already-deleted profile (both images carry it), so the purge runs
 * once per deletion, never on a response to some other write.
 */
function deletedProfileId(record: DynamoDBRecord): string | undefined {
  if (record.eventName !== "MODIFY") {
    return undefined;
  }
  const newImage = deletedProfileImageSchema.safeParse(record.dynamodb?.NewImage);
  if (!newImage.success) {
    return undefined;
  }
  const oldImage = profileImageSchema.safeParse(record.dynamodb?.OldImage);
  if (oldImage.success && oldImage.data.deletedAt !== undefined) {
    return undefined;
  }
  return newImage.data.profileId.S;
}

export interface ProfilePurgeHandlerDeps {
  purge: (profileId: string) => Promise<PurgeOutcome>;
  log?: (message: string) => void;
}

/**
 * The profile-purge lambda: the profiles stream's deletion records in, the
 * profile's staged storage out.
 *
 * A record that did not finish is reported as a batch item failure, so DynamoDB
 * Streams delivers it again and the purge converges from any point. A record
 * that is not a deletion is skipped silently — the event source mapping filters
 * on the same transition, and this check keeps the handler correct without it.
 */
export function createProfilePurgeHandler(
  deps: ProfilePurgeHandlerDeps,
): (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse> {
  const log = deps.log ?? console.error;

  return async (event) => {
    const batchItemFailures: DynamoDBBatchResponse["batchItemFailures"] = [];

    const reportFailure = (record: DynamoDBRecord): void => {
      const sequenceNumber = record.dynamodb?.SequenceNumber;
      if (sequenceNumber === undefined) {
        log("[profile-purge] record has no sequence number; nothing to redeliver");
        return;
      }
      batchItemFailures.push({ itemIdentifier: sequenceNumber });
    };

    for (const record of event.Records) {
      const profileId = deletedProfileId(record);
      if (profileId === undefined) {
        continue;
      }
      try {
        const outcome = await deps.purge(profileId);
        if (outcome.status === "exhausted") {
          log(`[profile-purge] budget exhausted for ${profileId}; handing the record back`);
          reportFailure(record);
        }
      } catch (error) {
        log(`[profile-purge] failed to purge ${profileId}: ${String(error)}`);
        reportFailure(record);
      }
    }

    return { batchItemFailures };
  };
}

let cachedDocClient: DynamoDBDocumentClient | undefined;

function docClient(): DynamoDBDocumentClient {
  cachedDocClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedDocClient;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} env var not set`);
  }
  return value;
}

/**
 * Binds the purge to its runtime config. Built per invocation, so missing
 * configuration fails fast at cold start instead of at import.
 */
function createPurge(): (profileId: string) => Promise<PurgeOutcome> {
  const index = new DynamoDBStagedIndexStore({
    // The staged index table, under the env name the dispatch lambda uses.
    client: docClient(),
    tableName: requiredEnv("FILE_RECORDS_TABLE"),
  });
  const objectStore = new S3StagedObjectStore({
    bucket: requiredEnv("STAGED_PDFS_BUCKET"),
    region: process.env["AWS_REGION"] ?? "eu-west-2",
  });

  return (profileId) => purgeStagedStorageForProfile({ index, objectStore }, profileId);
}

/** Profile-purge lambda entrypoint: the profiles stream's deletion records. */
export const handler = (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> =>
  createProfilePurgeHandler({ purge: createPurge() })(event);

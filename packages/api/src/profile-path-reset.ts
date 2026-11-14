import { DeleteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoDBStagedIndexStore,
  S3StagedObjectStore,
  type StagedIndexStore,
  type StagedObjectStore,
} from "@petroglyph/staging-contracts";
import { docClient } from "./db.js";
import { sqsClient } from "./sqs.js";
import {
  createSyncTriggerEnqueuer,
  deltaTriggerQueueUrl,
  type DeltaTriggerEnqueuer,
} from "./sync-trigger.js";
import { ONEDRIVE_PROVIDER } from "./token-vault.js";

/** The connection a reset acts on; the delta state is keyed by the pair. */
export interface ConnectionKey {
  userId: string;
  provider: string;
}

/** Which profile's staged state to discard. */
export interface ProfilePathResetTarget {
  userId: string;
  profileId: string;
}

/**
 * Everything one path-change reset touches. The two stores are resolved per
 * call, so building the app reads no configuration and the request that needs
 * a bucket or table name is the one that fails without it.
 */
export interface ProfilePathResetDeps {
  stagedIndex: () => StagedIndexStore;
  stagedObjects: () => StagedObjectStore;
  clearChangeToken: (connection: ConnectionKey) => Promise<void>;
  enqueueDeltaTrigger: DeltaTriggerEnqueuer;
}

/**
 * Discards one profile's staged state and asks the adapter to walk the drive
 * again from the beginning. A command: it reports only that it finished.
 */
export type ProfilePathReset = (target: ProfilePathResetTarget) => Promise<void>;

/**
 * Records deleted per page. A profile can hold a whole drive's worth of
 * staged files, so the reset reads, deletes and forgets one page at a time
 * instead of holding every key in memory.
 */
const RESET_PAGE_LIMIT = 100;

/**
 * The reset owed when a profile's `sourceFolderPath` changes. The feed scopes
 * by PROFILE, so records staged under the old path would keep being served;
 * and the walk's change token is per CONNECTION, so a stored token covers only
 * what changed since — never the files already sitting under the new path.
 *
 * Order, and why:
 * 1. index records — the s3Key of each one is read first, because the record is
 *    the only place a staged key is named;
 * 2. the staged objects those records name — after the records, so a failure
 *    between the two leaves objects with no reader rather than records whose
 *    object 404s from `GET /files`;
 * 3. the connection's change token — last, so a failure above leaves a token,
 *    a pending marker and a walk that is still correct;
 * 4. the bell — only once the state it re-enumerates is actually gone.
 *
 * Every step is idempotent, so a retry of the whole reset is safe. A partial
 * failure leaves the profile's marker set (the caller wrote it before calling
 * this), so the next walk re-enumerates from the beginning and the reset is
 * not half-forgotten; abandoned staged objects expire on the bucket's
 * `expire-staged-pdfs` lifecycle rule.
 */
export function createProfilePathReset(deps: ProfilePathResetDeps): ProfilePathReset {
  return async (target) => {
    const index = deps.stagedIndex();
    const objects = deps.stagedObjects();

    let cursor: string | undefined;
    do {
      const page = await index.queryFeed({
        profileId: target.profileId,
        limit: RESET_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        await index.remove(record.profileId, record.itemId);
      }
      for (const record of page.records) {
        await objects.delete(record.s3Key);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    await deps.clearChangeToken({ userId: target.userId, provider: ONEDRIVE_PROVIDER });
    await deps.enqueueDeltaTrigger({ userId: target.userId, provider: ONEDRIVE_PROVIDER });
  };
}

/**
 * Deletes the connection's change-token row. Absent is the same state the
 * reset wants, and a `DeleteItem` on a missing key is a no-op, so no read is
 * needed first.
 */
export function createChangeTokenClear(
  client: DynamoDBDocumentClient,
  resolveTableName: () => string,
): (connection: ConnectionKey) => Promise<void> {
  return async (connection) => {
    await client.send(
      new DeleteCommand({
        TableName: resolveTableName(),
        Key: { userId: connection.userId, provider: connection.provider },
      }),
    );
  };
}

function stagedRecordsTableName(): string {
  return process.env["STAGED_RECORDS_TABLE"] ?? "petroglyph-staged-records-default";
}

function deltaStatesTableName(): string {
  return process.env["DELTA_TOKENS_TABLE"] ?? "petroglyph-delta-states-default";
}

function stagedBucketName(): string {
  const bucket = process.env["STAGED_PDFS_BUCKET"];
  if (bucket === undefined || bucket === "") {
    throw new Error("Missing required environment variable: STAGED_PDFS_BUCKET");
  }
  return bucket;
}

/** The deployed reset: real staged index, real bucket, real token table, real bell. */
export function createDeployedProfilePathReset(): ProfilePathReset {
  return createProfilePathReset({
    stagedIndex: () =>
      new DynamoDBStagedIndexStore({
        client: docClient(),
        tableName: stagedRecordsTableName(),
      }),
    stagedObjects: () =>
      new S3StagedObjectStore({
        bucket: stagedBucketName(),
        region: process.env["AWS_REGION"] ?? "eu-west-2",
      }),
    clearChangeToken: createChangeTokenClear(docClient(), deltaStatesTableName),
    // The one enqueue path: the same SendMessage mapping the catch-up sweep and
    // Sync Now use, so the queue's address and FIFO ids stay in one place.
    enqueueDeltaTrigger: createSyncTriggerEnqueuer(sqsClient(), deltaTriggerQueueUrl),
  });
}

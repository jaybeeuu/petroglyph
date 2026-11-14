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
  /**
   * Records one invocation may discard; defaults to RESET_RECORD_BUDGET. The
   * default is sized for the API lambda's 30 s timeout, and exists as a field
   * so a test can prove the bound at a scale LocalStack can stage quickly.
   */
  recordBudget?: number;
}

/**
 * Whether one attempt discarded everything. "incomplete" means the budget ran
 * out with records still staged, so the caller must not report success: the
 * marker it stored keeps the reset owed and a repeated request resumes it.
 */
export type ProfilePathResetOutcome = "completed" | "incomplete";

/**
 * Discards one profile's staged state and asks the adapter to walk the drive
 * again from the beginning. A command: it reports only whether its sweep
 * finished.
 */
export type ProfilePathReset = (target: ProfilePathResetTarget) => Promise<ProfilePathResetOutcome>;

/**
 * Records read and deleted per page. A page is written back as 4
 * BatchWriteItem calls (DynamoDB takes 25 at a time) plus 1 DeleteObjects call
 * (S3 takes 1000), instead of 2 calls per record.
 */
const RESET_PAGE_LIMIT = 100;

/**
 * Records one reset attempt may discard — 2000 records is 20 pages, so about
 * 100 batched requests. At the ~30 ms a DynamoDB or S3 request costs from
 * inside its own region that is roughly 3 s, a tenth of the API lambda's 30 s
 * timeout. A larger profile does not overrun the lambda: the attempt stops at
 * the budget, reports "incomplete", and the next request carries on from what
 * is still staged.
 */
const RESET_RECORD_BUDGET = 2000;

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
 * 3. the connection's change token — only once no staged record is left, so a
 *    partial sweep never drops a token that the pending marker cannot re-earn;
 * 4. the bell — only once the state it re-enumerates is actually gone.
 *
 * Two properties make an attempt safe to repeat, and they are the reason a
 * sweep that cannot finish is not a lost cause:
 * - every delete is idempotent, so repeating one is a no-op;
 * - the sweep re-reads the feed each attempt, so it resumes at whatever is
 *   still staged rather than at a cursor the caller has to carry. Nothing is
 *   counted down and nothing is assumed about how far a killed attempt got.
 *
 * A record budget bounds one attempt (see RESET_RECORD_BUDGET) and a remaining
 * page makes it report "incomplete" instead of pretending to be done. The
 * caller has already stored the profile's marker before calling this, so the
 * obligation survives the failure of either side.
 */
export function createProfilePathReset(deps: ProfilePathResetDeps): ProfilePathReset {
  return async (target) => {
    const index = deps.stagedIndex();
    const objects = deps.stagedObjects();
    const budget = deps.recordBudget ?? RESET_RECORD_BUDGET;

    let deleted = 0;
    let cursor: string | undefined;
    for (;;) {
      const remaining = budget - deleted;
      // One record past the budget is enough to know the sweep is not done, so
      // the attempt never spends more than it is allowed and never guesses.
      const page = await index.queryFeed({
        profileId: target.profileId,
        limit: Math.min(RESET_PAGE_LIMIT, Math.max(remaining, 1)),
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page.records.length === 0) {
        break;
      }
      if (remaining <= 0) {
        return "incomplete";
      }
      await index.removeMany(
        target.profileId,
        page.records.map((record) => record.itemId),
      );
      await objects.deleteMany(page.records.map((record) => record.s3Key));
      deleted += page.records.length;
      if (page.nextCursor === undefined) {
        break;
      }
      cursor = page.nextCursor;
    }

    await deps.clearChangeToken({ userId: target.userId, provider: ONEDRIVE_PROVIDER });
    await deps.enqueueDeltaTrigger({ userId: target.userId, provider: ONEDRIVE_PROVIDER });
    return "completed";
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

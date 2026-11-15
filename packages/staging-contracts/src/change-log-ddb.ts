import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  stagedChangeSchema,
  type AppendOutcome,
  type StagedChange,
  type StagedChangeInput,
  type StagedChangeLog,
} from "./change-log.js";

/**
 * Seq keys are zero-padded fixed-width decimals, so the table's lexicographic
 * sort order IS numeric order: "…0002" < "…0010", where the bare strings "2"
 * and "10" would sort the other way round.
 */
const SEQ_WIDTH = 20;
const SEQ_LIMIT = 10 ** SEQ_WIDTH;

/**
 * The two row namespaces that share the profile's partition live outside the
 * log's sort range. "!" (0x21) sorts below every digit, "~" (0x7e) above ":"
 * (0x3a), the ceiling of the digit range — so a feed query never sees them.
 */
const COUNTER_KEY = "!seq";
const CHANGE_MARKER_PREFIX = "~change#";
const SEQ_CEILING = ":";

/** Long enough for any redelivery window; a marker only guards one change id. */
const MARKER_RETENTION_SECONDS = 7 * 24 * 60 * 60;

const DEFAULT_PAGE_SIZE = 100;

export function seqKeyFor(seq: number): string {
  if (seq <= 0 || seq >= SEQ_LIMIT) {
    throw new Error(`Change log seq ${String(seq)} is out of range`);
  }
  return String(seq).padStart(SEQ_WIDTH, "0");
}

function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

/**
 * A stored row carries the padded key under `seq`; the domain carries a number,
 * so the encoding is undone here and never leaks past this adapter.
 */
function parseChange(item: { [key: string]: unknown }): StagedChange {
  return stagedChangeSchema.parse({ ...item, seq: Number(item["seq"]) });
}

/**
 * DynamoDB-backed change log: one table keyed {profileId, seq}, with two row
 * namespaces in the same partition.
 *
 * `seq` is allocated by an atomic increment of a per-profile counter row, which
 * makes it strictly monotonic — a late or retried change always receives the
 * highest seq and is therefore served, where a `stagedAt + itemId` composite
 * would land behind a cursor that had already moved past that instant.
 *
 * The append is gated by a conditional put of a marker keyed on the change id,
 * because an append-only log must not record a redelivered change twice. The
 * marker is claimed before the counter moves, so a duplicate burns no seq; a
 * failed append releases the claim so the retry can re-attempt it. A seq lost
 * this way leaves a gap, which is harmless: readers ask for `seq > cursor`.
 *
 * The class names the transport (DynamoDB); `StagedChangeLog` stays the
 * consumer-facing capability, so callers keep injecting it and tests keep
 * substituting fakes.
 */
export class DynamoDBStagedChangeLog implements StagedChangeLog {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;

  constructor(options: { client: DynamoDBDocumentClient; tableName: string }) {
    this.#client = options.client;
    this.#tableName = options.tableName;
  }

  async append(change: StagedChangeInput): Promise<AppendOutcome> {
    if (!(await this.#claimChange(change))) {
      return { status: "duplicate" };
    }

    try {
      const seq = await this.#nextSeq(change.profileId);
      await this.#client.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: { ...change, seq: seqKeyFor(seq) },
        }),
      );
      return { status: "appended" };
    } catch (error) {
      await this.#releaseChange(change);
      throw error;
    }
  }

  async read(options: {
    profileId: string;
    after?: number;
    limit?: number;
  }): Promise<StagedChange[]> {
    const result = await this.#client.send(
      new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "profileId = :profileId AND #seq BETWEEN :from AND :to",
        ExpressionAttributeNames: { "#seq": "seq" },
        ExpressionAttributeValues: {
          ":profileId": options.profileId,
          ":from": seqKeyFor((options.after ?? 0) + 1),
          ":to": SEQ_CEILING,
        },
        ScanIndexForward: true,
        Limit: options.limit ?? DEFAULT_PAGE_SIZE,
      }),
    );
    return (result.Items ?? []).map(parseChange);
  }

  /** Claims the change id, returning false when it is already logged. */
  async #claimChange(change: StagedChangeInput): Promise<boolean> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: {
            profileId: change.profileId,
            seq: `${CHANGE_MARKER_PREFIX}${change.changeId}`,
            changeId: change.changeId,
            expiresAt: Math.floor(Date.now() / 1000) + MARKER_RETENTION_SECONDS,
          },
          ConditionExpression: "attribute_not_exists(#seq)",
          ExpressionAttributeNames: { "#seq": "seq" },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Drops a claim whose append failed, so the retry can log the change. This is
   * best effort: the original failure is what the caller must see.
   */
  async #releaseChange(change: StagedChangeInput): Promise<void> {
    try {
      await this.#client.send(
        new DeleteCommand({
          TableName: this.#tableName,
          Key: {
            profileId: change.profileId,
            seq: `${CHANGE_MARKER_PREFIX}${change.changeId}`,
          },
        }),
      );
    } catch {
      // The marker expires on its own, and the retry still appends.
    }
  }

  async #nextSeq(profileId: string): Promise<number> {
    const result = await this.#client.send(
      new UpdateCommand({
        TableName: this.#tableName,
        Key: { profileId, seq: COUNTER_KEY },
        UpdateExpression: "ADD #count :one",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const seq = Number(result.Attributes?.["count"] ?? Number.NaN);
    if (!Number.isInteger(seq) || seq <= 0) {
      throw new Error(`Change log counter for profile ${profileId} returned no count`);
    }
    return seq;
  }
}

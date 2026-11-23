import {
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { CancellationReason } from "@aws-sdk/client-dynamodb";
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

/** The cancellation code DynamoDB reports for a failed condition inside a transaction. */
const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailed";
const TRANSACTION_CANCELLED = "TransactionCanceledException";

/**
 * A cancellation whose only cause was the marker's condition: the change is
 * already logged, so nothing was written and the outcome is a duplicate.
 *
 * Any other cancellation - a conflict on the marker, say - is NOT a duplicate:
 * the append did not land, so the caller must retry it.
 */
function isDuplicateCancellation(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== TRANSACTION_CANCELLED) {
    return false;
  }
  // The SDK types the reasons on its own error class; the name is checked first
  // because the error may come from another copy of the SDK in the graph.
  const reasons =
    (error as { CancellationReasons?: CancellationReason[] }).CancellationReasons ?? [];
  return reasons.some((reason) => reason.Code === CONDITIONAL_CHECK_FAILED);
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
 * The append commits as ONE transaction: a put of the row under the `seq` the
 * counter just allocated, and a put of a marker keyed on the change id under
 * `ConditionExpression: attribute_not_exists`. Either both land or neither
 * does, so no window exists in which a change is claimed but not yet logged.
 *
 * A cancelled transaction is the duplicate outcome: the marker already exists,
 * because a redelivery of a change that was logged before carries the same id.
 * A crash therefore loses nothing — the seq it allocated leaves a gap, which is
 * harmless because readers ask for `seq > cursor` — and a lost response leaves
 * both items, so the redelivery is recognised as a duplicate rather than
 * appended twice.
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
    const seq = await this.#nextSeq(change.profileId);

    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.#tableName,
                Item: { ...change, seq: seqKeyFor(seq) },
              },
            },
            {
              Put: {
                TableName: this.#tableName,
                Item: {
                  profileId: change.profileId,
                  seq: `${CHANGE_MARKER_PREFIX}${change.changeId}`,
                  changeId: change.changeId,
                  expiresAt: Math.floor(Date.now() / 1000) + MARKER_RETENTION_SECONDS,
                },
                ConditionExpression: "attribute_not_exists(#seq)",
                ExpressionAttributeNames: { "#seq": "seq" },
              },
            },
          ],
        }),
      );
      return { status: "appended" };
    } catch (error) {
      if (isDuplicateCancellation(error)) {
        return { status: "duplicate" };
      }
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

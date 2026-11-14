import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { stagedRecordSchema, type StagedRecord } from "./record.js";
import type { FeedPage, StagedIndexStore } from "./index-store.js";

/** DynamoDB accepts at most 25 write requests in one BatchWrite command. */
const BATCH_WRITE_LIMIT = 25;

/**
 * Rounds a batch gets before its unprocessed keys become an error. DynamoDB
 * hands back the keys it did not write, and a bulk sweep is exactly where
 * throttling happens, so one retry round is worth the code.
 */
const BATCH_WRITE_ROUNDS = 3;

function extractLastEvaluatedItemId(
  lastEvaluatedKey: { [key: string]: unknown } | undefined,
): string | undefined {
  const value = lastEvaluatedKey?.["itemId"];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "S" in value) {
    const s = value["S"];
    return typeof s === "string" ? s : undefined;
  }
  return undefined;
}

/**
 * DDB-backed index over staged records: hash {profileId, itemId}, records
 * only after FileStaged applies; removes are idempotent; the feed queries
 * staged rows ordered by itemId with a deterministic cursor (last key).
 * The feed resumes exclusively after the last returned itemId.
 *
 * The class names the transport (DynamoDB); the `StagedIndexStore` interface
 * stays the consumer-facing capability, so consumers keep injecting it and
 * tests keep substituting fakes.
 */
export class DynamoDBStagedIndexStore implements StagedIndexStore {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;

  constructor(options: { client: DynamoDBDocumentClient; tableName: string }) {
    this.#client = options.client;
    this.#tableName = options.tableName;
  }

  async upsert(record: StagedRecord): Promise<void> {
    await this.#client.send(
      new PutCommand({
        TableName: this.#tableName,
        Item: record,
      }),
    );
  }

  async get(profileId: string, itemId: string): Promise<StagedRecord | null> {
    const result = await this.#client.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { profileId, itemId },
      }),
    );
    if (result.Item === undefined) {
      return null;
    }
    return stagedRecordSchema.parse(result.Item);
  }

  async remove(profileId: string, itemId: string): Promise<void> {
    await this.#client.send(
      new DeleteCommand({
        TableName: this.#tableName,
        Key: { profileId, itemId },
      }),
    );
  }

  async removeMany(profileId: string, itemIds: readonly string[]): Promise<void> {
    for (let start = 0; start < itemIds.length; start += BATCH_WRITE_LIMIT) {
      await this.#removeBatch(profileId, itemIds.slice(start, start + BATCH_WRITE_LIMIT));
    }
  }

  /**
   * Deletes one batch, rewriting only the keys DynamoDB reports as unprocessed.
   * A remainder after the last round is an error: the caller's sweep is
   * repeatable, so failing loudly beats reporting a delete that did not happen.
   */
  async #removeBatch(profileId: string, itemIds: readonly string[]): Promise<void> {
    const pending = itemIds;
    for (let round = 1; pending.length > 0; round += 1) {
      const result = await this.#client.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.#tableName]: pending.map((itemId) => ({
              DeleteRequest: { Key: { profileId, itemId } },
            })),
          },
        }),
      );
      const unprocessed = result.UnprocessedItems?.[this.#tableName] ?? [];
      if (unprocessed.length === 0) {
        return;
      }
      if (round === BATCH_WRITE_ROUNDS) {
        throw new Error(
          `DynamoDB left ${unprocessed.length} staged record delete(s) unprocessed after ${round} rounds`,
        );
      }
      // The whole batch is retried, not just the keys DynamoDB echoed back: a
      // delete of an already-deleted key is a no-op, so rewriting the batch is
      // both safe and cheaper than reading the echoed request.
    }
  }

  async listUnderPath(profileId: string, path: string): Promise<StagedRecord[]> {
    const result = await this.#client.send(
      new ScanCommand({
        TableName: this.#tableName,
        FilterExpression:
          "profileId = :profileId AND (#rel = :path OR begins_with(#rel, :pathSlash))",
        ExpressionAttributeNames: { "#rel": "relativePath" },
        ExpressionAttributeValues: {
          ":profileId": profileId,
          ":path": path,
          ":pathSlash": `${path}/`,
        },
      }),
    );
    return (result.Items ?? []).map((item) => stagedRecordSchema.parse(item));
  }

  async removeUnderPath(profileId: string, path: string): Promise<void> {
    const under = await this.listUnderPath(profileId, path);
    for (const record of under) {
      await this.#client.send(
        new DeleteCommand({
          TableName: this.#tableName,
          Key: { profileId: record.profileId, itemId: record.itemId },
        }),
      );
    }
  }

  async queryFeed(feedOptions: {
    profileId: string;
    limit?: number;
    cursor?: string;
  }): Promise<FeedPage> {
    const result = await this.#client.send(
      new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "profileId = :profileId",
        ExpressionAttributeValues: { ":profileId": feedOptions.profileId },
        Limit: feedOptions.limit,
        ...(feedOptions.cursor === undefined
          ? {}
          : {
              ExclusiveStartKey: {
                profileId: feedOptions.profileId,
                itemId: feedOptions.cursor,
              },
            }),
      }),
    );
    const records = (result.Items ?? []).map((item) => stagedRecordSchema.parse(item));
    // DocumentClient returns native values, but stay tolerant of the
    // marshalled { S } shape — the feed cursor is always a string.
    const nextItemId = extractLastEvaluatedItemId(result.LastEvaluatedKey);
    return {
      records,
      ...(nextItemId === undefined ? {} : { nextCursor: nextItemId }),
    };
  }
}

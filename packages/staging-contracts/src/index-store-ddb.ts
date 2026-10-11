import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { stagedRecordSchema, type StagedRecord } from "./record.js";
import type { FeedPage, StagedIndexStore } from "./index-store.js";

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

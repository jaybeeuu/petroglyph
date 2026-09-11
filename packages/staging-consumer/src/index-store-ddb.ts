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

/**
 * DDB-backed index over staged records: hash {profileId, itemId}, records
 * only after FileStaged applies; removes are idempotent; the feed queries
 * staged rows ordered by itemId with a deterministic cursor (last key).
 */
export function createStagedIndexStoreDdb(options: {
  client: DynamoDBDocumentClient;
  tableName: string;
}): StagedIndexStore {
  async function listUnderPath(profileId: string, path: string): Promise<StagedRecord[]> {
    const result = await options.client.send(
      new ScanCommand({
        TableName: options.tableName,
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

  async function removeUnderPath(profileId: string, path: string): Promise<void> {
    const under = await listUnderPath(profileId, path);
    for (const record of under) {
      await options.client.send(
        new DeleteCommand({
          TableName: options.tableName,
          Key: { profileId: record.profileId, itemId: record.itemId },
        }),
      );
    }
  }

  return {
    async upsert(record) {
      await options.client.send(
        new PutCommand({
          TableName: options.tableName,
          Item: record,
        }),
      );
    },

    async get(profileId, itemId) {
      const result = await options.client.send(
        new GetCommand({
          TableName: options.tableName,
          Key: { profileId, itemId },
        }),
      );
      if (result.Item === undefined) {
        return null;
      }
      return stagedRecordSchema.parse(result.Item);
    },

    async remove(profileId, itemId) {
      await options.client.send(
        new DeleteCommand({
          TableName: options.tableName,
          Key: { profileId, itemId },
        }),
      );
    },

    listUnderPath,
    removeUnderPath,

    async queryFeed(feedOptions) {
      const result = await options.client.send(
        new QueryCommand({
          TableName: options.tableName,
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
      const nextItemId = result.LastEvaluatedKey?.["itemId"];
      return {
        records,
        ...(nextItemId === undefined ? {} : { nextCursor: String(nextItemId) }),
      };
    },
  };
}

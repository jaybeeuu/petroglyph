import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { DeltaStateStore } from "./delta-state-store.js";

const deltaStateSchema = z.object({
  deltaLink: z.string().min(1),
  updatedAt: z.string().min(1),
});

export function createDeltaStateStoreDdb(options: {
  client: DynamoDBDocumentClient;
  tableName: string;
}): DeltaStateStore {
  return {
    async read(userId, provider) {
      const result = await options.client.send(
        new GetCommand({
          TableName: options.tableName,
          Key: { userId, provider },
        }),
      );
      if (result.Item === undefined) {
        return null;
      }
      return deltaStateSchema.parse(result.Item);
    },

    async write(userId, provider, state) {
      await options.client.send(
        new UpdateCommand({
          TableName: options.tableName,
          Key: { userId, provider },
          UpdateExpression: "SET deltaLink = :deltaLink, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":deltaLink": state.deltaLink,
            ":updatedAt": state.updatedAt,
          },
        }),
      );
    },

    async clear(userId, provider) {
      await options.client.send(
        new DeleteCommand({
          TableName: options.tableName,
          Key: { userId, provider },
        }),
      );
    },
  };
}

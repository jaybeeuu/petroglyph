import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { TokenRecord, TokenStore } from "@petroglyph/core";

export const tokenRecordSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expirySeconds: z.number().int().positive(),
  updatedAt: z.string().min(1),
  reconnectRequired: z.boolean(),
});

type StoredTokenRecord = TokenRecord & { userId: string; provider: string };

const CAS_FAILURE_NAME = "ConditionalCheckFailedException";

function isConditionalCheckFailure(error: unknown): boolean {
  return (error as { name?: unknown }).name === CAS_FAILURE_NAME;
}

/**
 * Connection-keyed (userId, provider) token vault on DDB. CAS write = one
 * UpdateCommand + ConditionExpression, so a rotated-in copy never overwrites
 * the winner under concurrent refresh (MS rotates refresh tokens every time).
 */
export function createTokenStoreDdb(options: {
  client: DynamoDBDocumentClient;
  tableName: string;
}): TokenStore {
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
      return tokenRecordSchema.parse(result.Item);
    },

    async write(userId, provider, record, expected) {
      if (expected === undefined) {
        const item: StoredTokenRecord = { userId, provider, ...record };
        await options.client.send(
          new PutCommand({
            TableName: options.tableName,
            Item: item,
          }),
        );
        return true;
      }

      try {
        await options.client.send(
          new UpdateCommand({
            TableName: options.tableName,
            Key: { userId, provider },
            UpdateExpression:
              "SET accessToken = :accessToken, refreshToken = :refreshToken, expirySeconds = :expirySeconds, updatedAt = :updatedAt, reconnectRequired = :reconnectRequired",
            ConditionExpression:
              "updatedAt = :expectedUpdatedAt AND expirySeconds = :expectedExpirySeconds",
            ExpressionAttributeValues: {
              ":accessToken": record.accessToken,
              ":refreshToken": record.refreshToken,
              ":expirySeconds": record.expirySeconds,
              ":updatedAt": record.updatedAt,
              ":reconnectRequired": record.reconnectRequired,
              ":expectedUpdatedAt": expected.updatedAt,
              ":expectedExpirySeconds": expected.expirySeconds,
            },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalCheckFailure(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}

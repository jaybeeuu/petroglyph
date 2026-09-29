import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { tokenRecordSchema } from "@petroglyph/core";
import type { TokenRecord, TokenStore } from "@petroglyph/core";

export { tokenRecordSchema };

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
export class DynamoDBTokenStore implements TokenStore {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;

  constructor(options: { client: DynamoDBDocumentClient; tableName: string }) {
    this.#client = options.client;
    this.#tableName = options.tableName;
  }

  async read(userId: string, provider: string): Promise<TokenRecord | null> {
    const result = await this.#client.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { userId, provider },
      }),
    );
    if (result.Item === undefined) {
      return null;
    }
    return tokenRecordSchema.parse(result.Item);
  }

  async write(
    userId: string,
    provider: string,
    record: TokenRecord,
    expected?: TokenRecord,
  ): Promise<boolean> {
    if (expected === undefined) {
      const item: StoredTokenRecord = { userId, provider, ...record };
      await this.#client.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: item,
        }),
      );
      return true;
    }

    try {
      await this.#client.send(
        new UpdateCommand({
          TableName: this.#tableName,
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
  }
}

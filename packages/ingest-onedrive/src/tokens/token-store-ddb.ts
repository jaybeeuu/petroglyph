import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { tokenRecordSchema } from "@petroglyph/core";
import type { TokenRecord, TokenStore } from "@petroglyph/core";
import { z } from "zod";

export { tokenRecordSchema };

/** A vault row's identity plus the one field the catch-up sweep branches on. */
export const storedConnectionSchema = z.object({
  userId: z.string().min(1),
  provider: z.string().min(1),
  reconnectRequired: z.boolean(),
});

export type StoredConnection = z.infer<typeof storedConnectionSchema>;

/** Just the identity of a vault row, readable even when the rest fails the schema. */
const connectionIdentitySchema = z.object({
  userId: z.string().min(1),
  provider: z.string().min(1),
});

type StoredTokenRecord = TokenRecord & { userId: string; provider: string };

export interface DynamoDBTokenStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** Where a vault row skipped by the sweep is reported; defaults to console.error. */
  log?: (message: string) => void;
}

const CAS_FAILURE_NAME = "ConditionalCheckFailedException";

function describeConnection(item: unknown): string {
  const identity = connectionIdentitySchema.safeParse(item);
  return identity.success ? `${identity.data.userId}:${identity.data.provider}` : "unknown";
}

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
  readonly #log: (message: string) => void;

  constructor(options: DynamoDBTokenStoreOptions) {
    this.#client = options.client;
    this.#tableName = options.tableName;
    this.#log = options.log ?? console.error;
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

  /**
   * Every stored connection, for the scheduled catch-up sweep. A scan is the
   * right tool here: the vault is keyed by connection, and the sweep needs all
   * of them, once every few hours.
   *
   * A row that fails storedConnectionSchema is skipped and logged, naming the
   * connection when its identity is readable. One malformed row must never fail
   * the sweep: the sweep is the reliability net, so it degrades to the healthy
   * connections instead of going dark for every user.
   */
  async list(): Promise<StoredConnection[]> {
    const connections: StoredConnection[] = [];
    let lastEvaluatedKey: { [key: string]: unknown } | undefined;

    do {
      const result = await this.#client.send(
        new ScanCommand({
          TableName: this.#tableName,
          ProjectionExpression: "userId, provider, reconnectRequired",
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      for (const item of result.Items ?? []) {
        const connection = storedConnectionSchema.safeParse(item);
        if (!connection.success) {
          this.#log(
            `[ingest-onedrive] skipping malformed connection in token vault: ${describeConnection(item)}`,
          );
          continue;
        }
        connections.push(connection.data);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey !== undefined);

    return connections;
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

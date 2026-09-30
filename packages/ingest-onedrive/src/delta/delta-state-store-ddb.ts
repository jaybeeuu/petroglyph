import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { DeltaState, DeltaStateStore } from "./delta-state-store.js";

const deltaStateSchema = z.object({
  deltaLink: z.string().min(1),
  updatedAt: z.string().min(1),
});

export class DynamoDBDeltaStateStore implements DeltaStateStore {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;

  constructor(options: { client: DynamoDBDocumentClient; tableName: string }) {
    this.#client = options.client;
    this.#tableName = options.tableName;
  }

  async read(userId: string, provider: string): Promise<DeltaState | null> {
    const result = await this.#client.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { userId, provider },
      }),
    );
    if (result.Item === undefined) {
      return null;
    }
    return deltaStateSchema.parse(result.Item);
  }

  async write(userId: string, provider: string, state: DeltaState): Promise<void> {
    await this.#client.send(
      new UpdateCommand({
        TableName: this.#tableName,
        Key: { userId, provider },
        UpdateExpression: "SET deltaLink = :deltaLink, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":deltaLink": state.deltaLink,
          ":updatedAt": state.updatedAt,
        },
      }),
    );
  }

  async clear(userId: string, provider: string): Promise<void> {
    await this.#client.send(
      new DeleteCommand({
        TableName: this.#tableName,
        Key: { userId, provider },
      }),
    );
  }
}

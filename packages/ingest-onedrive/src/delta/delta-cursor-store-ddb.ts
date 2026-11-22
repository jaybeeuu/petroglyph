import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { DeltaCursor, DeltaCursorStore } from "./delta-cursor-store.js";

const deltaCursorSchema = z.object({
  deltaLink: z.string().min(1),
  updatedAt: z.string().min(1),
});

export class DynamoDBDeltaCursorStore implements DeltaCursorStore {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;

  constructor(options: { client: DynamoDBDocumentClient; tableName: string }) {
    this.#client = options.client;
    this.#tableName = options.tableName;
  }

  async read(profileId: string): Promise<DeltaCursor | null> {
    const result = await this.#client.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { profileId },
      }),
    );
    const item = result.Item;
    if (item === undefined) {
      return null;
    }
    // The table is shared with the legacy sync worker, which stores a bare
    // `deltaToken` under the same profile key. That row carries no deltaLink, so
    // it holds no cursor: the walk re-enumerates from scratch and overwrites it
    // with a real one. A deltaLink that is present but malformed is a corrupted
    // cursor and still fails loudly below.
    if (item["deltaLink"] === undefined) {
      return null;
    }
    return deltaCursorSchema.parse(item);
  }

  async write(profileId: string, cursor: DeltaCursor): Promise<void> {
    await this.#client.send(
      new UpdateCommand({
        TableName: this.#tableName,
        Key: { profileId },
        UpdateExpression: "SET deltaLink = :deltaLink, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":deltaLink": cursor.deltaLink,
          ":updatedAt": cursor.updatedAt,
        },
      }),
    );
  }

  async clear(profileId: string): Promise<void> {
    await this.#client.send(
      new DeleteCommand({
        TableName: this.#tableName,
        Key: { profileId },
      }),
    );
  }
}

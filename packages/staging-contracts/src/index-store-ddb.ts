import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { stagedRecordSchema, type StagedRecord } from "./record.js";
import type { StagedIndexStore } from "./index-store.js";

/**
 * DDB-backed index over staged records: hash {profileId, itemId}, records
 * only after FileStaged applies; removes are idempotent. There is no feed
 * query here: the change ORDER a client reads lives in the change log
 * (`DynamoDBStagedChangeLog`), never in this key.
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
}

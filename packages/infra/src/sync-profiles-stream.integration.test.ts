import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  type StreamViewType,
} from "@aws-sdk/client-dynamodb";
import {
  DescribeStreamCommand,
  DynamoDBStreamsClient,
  GetRecordsCommand,
  GetShardIteratorCommand,
  type _Record as DynamoDBStreamRecord,
  type OperationType,
} from "@aws-sdk/client-dynamodb-streams";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const PORT = 4566;
const TABLE_NAME = "petroglyph-sync-profiles-stream-int";
const infraDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The stream the deployed table declaration asks DynamoDB to keep, read out of
 * `dynamodb.tf` and handed to the real service. Terraform is the only place the
 * deployed stream view type is decided, so the spec has to come from there: a
 * hard-coded NEW_AND_OLD_IMAGES here would keep passing after the declaration
 * was narrowed back to NEW_IMAGE.
 */
interface DeclaredStream {
  viewType: StreamViewType;
}

function readResourceBlock(terraform: string, resourceType: string, name: string): string {
  const header = `resource "${resourceType}" "${name}" {`;
  const start = terraform.indexOf(header);
  if (start === -1) {
    throw new Error(`dynamodb.tf declares no ${resourceType} "${name}"`);
  }
  let depth = 0;
  for (let index = start + header.length - 1; index < terraform.length; index += 1) {
    const character = terraform[index];
    if (character === "{") {
      depth += 1;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return terraform.slice(start, index + 1);
      }
    }
  }
  throw new Error(`the ${resourceType} "${name}" block is never closed`);
}

function parseStreamViewType(value: string | undefined): StreamViewType {
  if (value === undefined) {
    throw new Error("the sync_profiles declaration names no stream_view_type");
  }
  switch (value) {
    case "KEYS_ONLY":
    case "NEW_IMAGE":
    case "OLD_IMAGE":
    case "NEW_AND_OLD_IMAGES":
      return value;
    default:
      throw new Error(
        `sync_profiles declares stream_view_type = ${value}, which is not a stream view type`,
      );
  }
}

function readSyncProfilesStream(): DeclaredStream {
  const terraform = readFileSync(resolve(infraDirectory, "dynamodb.tf"), "utf8");
  const block = readResourceBlock(terraform, "aws_dynamodb_table", "sync_profiles");
  if (!/^\s*stream_enabled\s*=\s*true\s*$/m.test(block)) {
    throw new Error("the sync_profiles declaration does not enable a stream");
  }
  const viewType = /^\s*stream_view_type\s*=\s*"([A-Z_]+)"\s*$/m.exec(block)?.[1];
  return { viewType: parseStreamViewType(viewType) };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

describe("sync-profiles stream", () => {
  let container: StartedTestContainer;
  let dynamo: DynamoDBClient;
  let streams: DynamoDBStreamsClient;
  let streamArn: string;
  let shardId: string;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(PORT)
      .withEnvironment({
        SERVICES: "dynamodb,dynamodbstreams",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: REGION,
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .withStartupTimeout(120_000)
      .start();

    const endpoint = `http://localhost:${container.getMappedPort(PORT)}`;
    dynamo = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    streams = new DynamoDBStreamsClient({ region: REGION, endpoint, credentials: CREDENTIALS });

    const { viewType } = readSyncProfilesStream();
    const created = await dynamo.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "profileId", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "userId", AttributeType: "S" },
          { AttributeName: "profileId", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        StreamSpecification: { StreamEnabled: true, StreamViewType: viewType },
      }),
    );
    const tableArn = created.TableDescription?.TableArn;
    if (tableArn === undefined) {
      throw new Error("CreateTable returned no table ARN");
    }
    const described = await dynamo.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    streamArn = described.Table?.LatestStreamArn ?? "";
    if (streamArn === "") {
      throw new Error("the table has no stream ARN");
    }
    const stream = await streams.send(new DescribeStreamCommand({ StreamArn: streamArn }));
    shardId = stream.StreamDescription?.Shards?.[0]?.ShardId ?? "";
    if (shardId === "") {
      throw new Error("the stream has no shard");
    }
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  /**
   * DynamoDB Streams reports no in-process completion signal, so the only way to
   * await a real record is to poll GetRecords. This polls the real transport; it
   * does not sleep on a stopwatch.
   */
  async function waitForStreamRecord(
    profileId: string,
    eventName: OperationType,
  ): Promise<DynamoDBStreamRecord> {
    const { ShardIterator } = await streams.send(
      new GetShardIteratorCommand({
        StreamArn: streamArn,
        ShardId: shardId,
        ShardIteratorType: "TRIM_HORIZON",
      }),
    );
    if (ShardIterator === undefined) {
      throw new Error("GetShardIterator returned no iterator");
    }
    let iterator = ShardIterator;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const page = await streams.send(new GetRecordsCommand({ ShardIterator: iterator }));
      const match = page.Records?.find(
        (record) =>
          record.eventName === eventName && record.dynamodb?.Keys?.["profileId"]?.S === profileId,
      );
      if (match !== undefined) {
        return match;
      }
      iterator = page.NextShardIterator ?? iterator;
      await delay(250);
    }
    throw new Error(`no ${eventName} stream record was observed for ${profileId}`);
  }

  it("keeps the row as it was before a soft delete on the MODIFY record", async () => {
    const deletedAt = "2026-11-21T09:00:00.000Z";
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: { S: "user-soft-delete" },
          profileId: { S: "profile-soft-delete" },
          sourceFolderPath: { S: "notes" },
          enabled: { BOOL: true },
        },
      }),
    );
    await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          userId: { S: "user-soft-delete" },
          profileId: { S: "profile-soft-delete" },
        },
        UpdateExpression: "SET deletedAt = :deletedAt",
        ExpressionAttributeValues: { ":deletedAt": { S: deletedAt } },
      }),
    );

    const record = await waitForStreamRecord("profile-soft-delete", "MODIFY");

    expect(record.dynamodb?.NewImage).toMatchObject({
      profileId: { S: "profile-soft-delete" },
      deletedAt: { S: deletedAt },
    });
    // The soft-delete filter reads the pre-change row to tell a change from a
    // deletion, so the old image must carry the row as it stood without
    // deletedAt.
    const oldImage = record.dynamodb?.OldImage;
    expect(oldImage).not.toHaveProperty("deletedAt");
    expect(oldImage).toMatchObject({
      profileId: { S: "profile-soft-delete" },
      sourceFolderPath: { S: "notes" },
      enabled: { BOOL: true },
    });
  }, 60_000);

  it("keeps the row as it was before removal on the REMOVE record", async () => {
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: { S: "user-purge" },
          profileId: { S: "profile-purge" },
          sourceFolderPath: { S: "journal" },
        },
      }),
    );
    await dynamo.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: { userId: { S: "user-purge" }, profileId: { S: "profile-purge" } },
      }),
    );

    const record = await waitForStreamRecord("profile-purge", "REMOVE");

    // The purge consumer reads the removed row's root to find what it staged.
    expect(record.dynamodb?.OldImage).toMatchObject({
      profileId: { S: "profile-purge" },
      sourceFolderPath: { S: "journal" },
    });
  }, 60_000);

  it("carries the new row on the INSERT record", async () => {
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: { S: "user-created" },
          profileId: { S: "profile-created" },
          sourceFolderPath: { S: "inbox" },
        },
      }),
    );

    const record = await waitForStreamRecord("profile-created", "INSERT");

    // The subscribe action derives its work from the created row.
    expect(record.dynamodb?.NewImage).toMatchObject({
      profileId: { S: "profile-created" },
      sourceFolderPath: { S: "inbox" },
    });
  }, 60_000);
});

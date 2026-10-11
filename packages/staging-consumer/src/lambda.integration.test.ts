import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DescribeStreamCommand,
  DynamoDBStreamsClient,
  GetRecordsCommand,
  GetShardIteratorCommand,
} from "@aws-sdk/client-dynamodb-streams";
import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  type Message,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { DynamoDBEventLogWriter, type CloudEvent } from "@petroglyph/events";
import type { FileStagedData } from "@petroglyph/staging-contracts";

const ENDPOINT = "http://localhost";
const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const EVENT_LOG_TABLE = "event-log-int";
const STAGED_EVENTS_QUEUE = "petroglyph-staged-events-int.fifo";
const ACCOUNT_ID = "000000000000";

const stagedDocument = {
  specversion: "1.0",
  id: "emission-1",
  source: "onedrive://profiles/p1",
  type: "petroglyph.file.staged",
  time: "2026-09-01T00:00:00.000Z",
  datacontenttype: "application/json",
  dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
  subject: "files/item-1",
  data: {
    profileId: "p1",
    source: "onedrive",
    changeType: "created",
    itemId: "item-1",
    name: "a.pdf",
    relativePath: "notes",
    s3Key: "staging/v1/p1/notes/a.pdf",
    mimeType: "application/pdf",
  },
} satisfies CloudEvent<FileStagedData>;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * DynamoDB Streams has no in-process completion signal, so the only way to
 * await a real record is to poll GetRecords — this loop polls the real
 * transport, it does not sleep on a stopwatch.
 */
async function readStreamRecords(
  streams: DynamoDBStreamsClient,
  streamArn: string,
  shardId: string,
): Promise<DynamoDBRecord[]> {
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const page = await streams.send(new GetRecordsCommand({ ShardIterator: iterator }));
    if (page.Records !== undefined && page.Records.length > 0) {
      // The GetRecords model and the `aws-lambda` event model describe the same
      // wire record but disagree on binary/timestamp representation; the real
      // records are what the deployed handler receives, so bridge the SDK type
      // to the handler's event type here rather than fabricating an event.
      return page.Records as unknown as DynamoDBRecord[];
    }
    iterator = page.NextShardIterator ?? iterator;
    await delay(250);
  }
  throw new Error("no DynamoDB stream record was observed");
}

describe("forwarder handler against LocalStack event-log stream + FIFO SQS", () => {
  let container: StartedTestContainer;
  let streams: DynamoDBStreamsClient;
  let eventLog: DynamoDBEventLogWriter;
  let sqs: SQSClient;
  let queueUrl: string;
  let streamArn: string;
  let shardId: string;
  let handler: (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb,dynamodbstreams,kinesis,sqs",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: REGION,
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .withStartupTimeout(120_000)
      .start();

    const endpoint = `${ENDPOINT}:${container.getMappedPort(4566)}`;
    queueUrl = queueUrlFrom(endpoint);
    // The forwarder's queue client is built inside the handler with no
    // endpoint or credentials; the env redirects it at LocalStack. The queue
    // URL must use the mapped host so the SDK does not fall back to the
    // container-internal QueueUrl host.
    vi.stubEnv("AWS_ENDPOINT_URL_SQS", endpoint);
    vi.stubEnv("STAGED_EVENTS_QUEUE_URL", queueUrl);
    vi.stubEnv("AWS_ACCESS_KEY_ID", CREDENTIALS.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", CREDENTIALS.secretAccessKey);
    vi.stubEnv("AWS_REGION", REGION);
    const dynamo = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    const created = await dynamo.send(
      new CreateTableCommand({
        TableName: EVENT_LOG_TABLE,
        KeySchema: [
          { AttributeName: "source", KeyType: "HASH" },
          { AttributeName: "id", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "source", AttributeType: "S" },
          { AttributeName: "id", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_IMAGE" },
      }),
    );
    streamArn = created.TableDescription?.LatestStreamArn ?? "";
    eventLog = new DynamoDBEventLogWriter({
      client: DynamoDBDocumentClient.from(dynamo),
      tableName: EVENT_LOG_TABLE,
    });

    streams = new DynamoDBStreamsClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    shardId = await awaitStreamShard(streams, streamArn);

    sqs = new SQSClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    await sqs.send(
      new CreateQueueCommand({ QueueName: STAGED_EVENTS_QUEUE, Attributes: { FifoQueue: "true" } }),
    );

    ({ handler } = await import("./lambda.js"));
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    vi.unstubAllEnvs();
  }, 30_000);

  it("forwards a real event-log INSERT to the FIFO queue with its CloudEvent body and profile group", async () => {
    await eventLog.putIfAbsent(stagedDocument);
    const records = await readStreamRecords(streams, streamArn, shardId);

    const response = await handler({ Records: records } satisfies DynamoDBStreamEvent);

    expect(response.batchItemFailures).toEqual([]);
    const messages = await receiveMessages(sqs, queueUrl);
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message).toBeDefined();
    if (message === undefined) throw new Error("expected one queue message");
    expect(JSON.parse(message.Body ?? "")).toMatchObject({
      id: "emission-1",
      source: "onedrive://profiles/p1",
      type: "petroglyph.file.staged",
      data: { profileId: "p1", itemId: "item-1", s3Key: "staging/v1/p1/notes/a.pdf" },
    });
    expect(message.Attributes?.["MessageGroupId"]).toBe("p1");
    expect(message.Attributes?.["MessageDeduplicationId"]).toBe(
      "onedrive://profiles/p1#emission-1",
    );
  }, 60_000);
});

function queueUrlFrom(endpoint: string): string {
  return `${endpoint}/${ACCOUNT_ID}/${STAGED_EVENTS_QUEUE}`;
}

async function awaitStreamShard(
  streams: DynamoDBStreamsClient,
  streamArn: string,
): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { StreamDescription } = await streams.send(
      new DescribeStreamCommand({ StreamArn: streamArn }),
    );
    const shard = StreamDescription?.Shards?.[0]?.ShardId;
    if (shard !== undefined) {
      try {
        await streams.send(
          new GetShardIteratorCommand({
            StreamArn: streamArn,
            ShardId: shard,
            ShardIteratorType: "TRIM_HORIZON",
          }),
        );
        return shard;
      } catch {
        // The stream's internal shard is not ready yet — keep polling.
      }
    }
    await delay(250);
  }
  throw new Error("event-log stream never became ready");
}

async function receiveMessages(sqs: SQSClient, queueUrl: string): Promise<Message[]> {
  const received = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      MessageSystemAttributeNames: ["MessageGroupId", "MessageDeduplicationId"],
    }),
  );
  return received.Messages ?? [];
}

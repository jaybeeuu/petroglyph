import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import type { TokenRecord } from "@petroglyph/core";
import { DEDUPE_WINDOW_SECONDS, createScheduledSweep } from "./catch-up.js";
import { deltaTriggerSchema, type DeltaTrigger } from "@petroglyph/contracts";
import { DynamoDBTokenStore } from "./tokens/token-store-ddb.js";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const ACCOUNT_ID = "000000000000";

/** A fixed instant inside one dedupe window, in milliseconds. */
const NOW_MS = 1_700_000_000_000;

function createTokenRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expirySeconds: 1_800_000_000,
    updatedAt: "2026-09-01T00:00:00.000Z",
    reconnectRequired: false,
    ...overrides,
  };
}

/** One bell as the real queue hands it back, already parsed by the consumer's schema. */
interface QueuedBell {
  bell: DeltaTrigger;
  messageGroupId: string | undefined;
}

describe("catch-up sweep against LocalStack DynamoDB + FIFO SQS", () => {
  let container: StartedTestContainer;
  let endpoint: string;
  let dynamo: DynamoDBClient;
  let sqs: SQSClient;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb,sqs",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: REGION,
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .withStartupTimeout(120_000)
      .start();

    endpoint = `http://localhost:${container.getMappedPort(4566)}`;
    // The sweep builds its own clients from the environment with no endpoint
    // or credentials; these redirect every one of them at LocalStack.
    vi.stubEnv("AWS_ENDPOINT_URL_DYNAMODB", endpoint);
    vi.stubEnv("AWS_ENDPOINT_URL_SQS", endpoint);
    vi.stubEnv("AWS_ACCESS_KEY_ID", CREDENTIALS.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", CREDENTIALS.secretAccessKey);
    vi.stubEnv("AWS_REGION", REGION);

    dynamo = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    sqs = new SQSClient({ region: REGION, endpoint, credentials: CREDENTIALS });
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    vi.unstubAllEnvs();
  }, 30_000);

  /**
   * A private table and queue per test keeps each sweep's scan and send
   * isolated: the sweep lists every connection in its table, so shared
   * infrastructure would leak one test's connections into another's queue.
   */
  async function createSweepHarness(options: { workspace: string; now: () => number }): Promise<{
    store: DynamoDBTokenStore;
    sweep: () => Promise<void>;
    drainBells: () => Promise<QueuedBell[]>;
  }> {
    const tableName = `token-vaults-${options.workspace}`;
    const queueName = `petroglyph-delta-trigger-${options.workspace}.fifo`;
    const queueUrl = `${endpoint}/${ACCOUNT_ID}/${queueName}`;

    await dynamo.send(
      new CreateTableCommand({
        TableName: tableName,
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "provider", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "userId", AttributeType: "S" },
          { AttributeName: "provider", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: { FifoQueue: "true", VisibilityTimeout: "300" },
      }),
    );

    vi.stubEnv("REFRESH_TOKENS_TABLE", tableName);
    vi.stubEnv("DELTA_TRIGGER_QUEUE_URL", queueUrl);

    return {
      store: new DynamoDBTokenStore({
        client: DynamoDBDocumentClient.from(dynamo),
        tableName,
      }),
      sweep: createScheduledSweep(options.now),
      drainBells: () => drainQueue(sqs, queueUrl),
    };
  }

  it("reads each stored connection back through the real projection", async () => {
    const { store } = await createSweepHarness({ workspace: "scan", now: () => NOW_MS });

    await store.write("github|healthy", "onedrive", createTokenRecord(), undefined);
    await store.write(
      "github|reconnect",
      "onedrive",
      createTokenRecord({ reconnectRequired: true }),
      undefined,
    );

    expect(await store.list()).toEqual(
      expect.arrayContaining([
        { userId: "github|healthy", provider: "onedrive", reconnectRequired: false },
        { userId: "github|reconnect", provider: "onedrive", reconnectRequired: true },
      ]),
    );
  }, 120_000);

  it("bells only the healthy connection, and the queue body parses as a delta trigger", async () => {
    const { store, sweep, drainBells } = await createSweepHarness({
      workspace: "healthy",
      now: () => NOW_MS,
    });

    await store.write("github|healthy", "onedrive", createTokenRecord(), undefined);
    await store.write(
      "github|reconnect",
      "onedrive",
      createTokenRecord({ reconnectRequired: true }),
      undefined,
    );

    await sweep();

    expect(await drainBells()).toEqual([
      {
        bell: { userId: "github|healthy", provider: "onedrive" },
        messageGroupId: "github|healthy:onedrive",
      },
    ]);
  }, 120_000);

  it("collapses a repeat sweep inside the dedupe window and re-bells after it", async () => {
    let nowMs = NOW_MS;
    const { store, sweep, drainBells } = await createSweepHarness({
      workspace: "dedupe",
      now: () => nowMs,
    });
    await store.write("github|dedupe", "onedrive", createTokenRecord(), undefined);

    await sweep();
    expect(await drainBells()).toHaveLength(1);

    // Same window → same deduplication id → SQS accepts and collapses the send.
    await sweep();
    expect(await drainBells()).toHaveLength(0);

    nowMs += DEDUPE_WINDOW_SECONDS * 1000;
    await sweep();
    expect(await drainBells()).toHaveLength(1);
  }, 120_000);

  it("bells the healthy connection while a malformed vault row sits beside it", async () => {
    const { store, sweep, drainBells } = await createSweepHarness({
      workspace: "malformed",
      now: () => NOW_MS,
    });

    // Written raw, as an older deploy would: `reconnectRequired` is absent, so the
    // row fails storedConnectionSchema. store.write() would reject it.
    await dynamo.send(
      new PutCommand({
        TableName: "token-vaults-malformed",
        Item: {
          userId: "github|bad",
          provider: "onedrive",
          accessToken: "access-bad",
          refreshToken: "refresh-bad",
          expirySeconds: 1_000_000,
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
    await store.write("github|healthy", "onedrive", createTokenRecord(), undefined);

    // The malformed row is skipped, so the sweep still resolves and the healthy
    // connection still gets a bell on the real queue.
    await expect(sweep()).resolves.toBeUndefined();
    expect(await drainBells()).toEqual([
      {
        bell: { userId: "github|healthy", provider: "onedrive" },
        messageGroupId: "github|healthy:onedrive",
      },
    ]);
  }, 120_000);
});

/** Receive every visible message, delete it, and parse its body as the consumer does. */
async function drainQueue(sqs: SQSClient, queueUrl: string): Promise<QueuedBell[]> {
  const bells: QueuedBell[] = [];
  for (;;) {
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    const messages: Message[] = received.Messages ?? [];
    if (messages.length === 0) {
      return bells;
    }
    for (const message of messages) {
      bells.push({
        bell: deltaTriggerSchema.parse(JSON.parse(message.Body ?? "")),
        messageGroupId: message.Attributes?.["MessageGroupId"],
      });
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
}

import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { deltaTriggerSchema, type DeltaTrigger } from "@petroglyph/contracts";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { resetKeyCache } from "./jwt.js";
import { createSyncTriggerEnqueuer } from "./sync-trigger.js";
import { readConnection, tokenVaultsTableName } from "./token-vault.js";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const ACCOUNT_ID = "000000000000";

/** One bell as the queue hands it back, parsed by the consumer's own schema. */
interface QueuedBell {
  bell: DeltaTrigger;
  messageGroupId: string | undefined;
}

/** The error envelope `docs/api-conventions.md` specifies. */
interface ErrorEnvelope {
  error: { code: string; message: string };
}

describe("POST /onedrive/sync-trigger against LocalStack DynamoDB + FIFO SQS", () => {
  let container: StartedTestContainer;
  let endpoint: string;
  let dynamo: DynamoDBClient;
  let sqs: SQSClient;
  let queueUrl: string;
  let privateKey: CryptoKey;

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
    dynamo = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    sqs = new SQSClient({ region: REGION, endpoint, credentials: CREDENTIALS });

    await dynamo.send(
      new CreateTableCommand({
        TableName: tokenVaultsTableName(),
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

    queueUrl = `${endpoint}/${ACCOUNT_ID}/petroglyph-delta-trigger-sync-trigger.fifo`;
    await sqs.send(
      new CreateQueueCommand({
        QueueName: "petroglyph-delta-trigger-sync-trigger.fifo",
        Attributes: { FifoQueue: "true", VisibilityTimeout: "300" },
      }),
    );

    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    vi.stubEnv("JWT_PUBLIC_KEY", await exportSPKI(keyPair.publicKey));
    resetKeyCache();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    vi.unstubAllEnvs();
    resetKeyCache();
  }, 30_000);

  beforeEach(async () => {
    // Each test starts from an empty queue: the suite shares one LocalStack
    // FIFO queue, so a leftover bell would mask a "nothing enqueued" assertion.
    await drainBells();
  }, 30_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The app under test: real vault reads and real FIFO sends, no Graph anywhere. */
  function createSyncTriggerApp(): ReturnType<typeof createApp> {
    return createApp({
      readConnection: (userId, provider) =>
        readConnection(DynamoDBDocumentClient.from(dynamo), userId, provider),
      enqueueDeltaTrigger: createSyncTriggerEnqueuer(sqs, () => queueUrl),
    });
  }

  async function makeToken(userId: string): Promise<string> {
    return new SignJWT({ username: "octocat" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(userId)
      .setIssuer("petroglyph-api")
      .setAudience("petroglyph-plugin")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  /** A stored connection, as `/onedrive/connect` writes it. */
  async function storeConnection(
    connection: { userId: string; reconnectRequired: boolean } = {
      userId: "user-42",
      reconnectRequired: false,
    },
  ): Promise<void> {
    await DynamoDBDocumentClient.from(dynamo).send(
      new PutCommand({
        TableName: tokenVaultsTableName(),
        Item: {
          userId: connection.userId,
          provider: "onedrive",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expirySeconds: 1_800_000_000,
          updatedAt: "2026-09-01T00:00:00.000Z",
          reconnectRequired: connection.reconnectRequired,
        },
      }),
    );
  }

  async function post(userId: string): Promise<Response> {
    return createSyncTriggerApp().request("/onedrive/sync-trigger", {
      method: "POST",
      headers: { Authorization: `Bearer ${await makeToken(userId)}` },
    });
  }

  async function drainBells(): Promise<QueuedBell[]> {
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
      if (received.Messages === undefined || received.Messages.length === 0) {
        return bells;
      }
      for (const message of received.Messages) {
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

  it("answers 202 and enqueues one bell addressed to the connection's FIFO group", async () => {
    await storeConnection({ userId: "user-42", reconnectRequired: false });

    const response = await post("user-42");

    expect(response.status).toBe(202);
    expect(await response.json()).toStrictEqual({ status: "queued" });
    expect(await drainBells()).toStrictEqual([
      {
        bell: { userId: "user-42", provider: "onedrive" },
        messageGroupId: "user-42:onedrive",
      },
    ]);
  }, 60_000);

  it("collapses a second Sync Now inside the dedupe window into the bell already queued", async () => {
    await storeConnection({ userId: "user-double-click", reconnectRequired: false });

    const first = await post("user-double-click");
    const second = await post("user-double-click");

    expect([first.status, second.status]).toStrictEqual([202, 202]);
    expect(await drainBells()).toStrictEqual([
      {
        bell: { userId: "user-double-click", provider: "onedrive" },
        messageGroupId: "user-double-click:onedrive",
      },
    ]);
  }, 60_000);

  it("refuses with no_connection and enqueues nothing when onboarding stored no connection", async () => {
    const response = await post("user-never-onboarded");
    const body = (await response.json()) as ErrorEnvelope;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("no_connection");
    expect(body.error.message).toMatch(/onboard/);
    expect(await drainBells()).toStrictEqual([]);
  }, 60_000);

  it("refuses with reconnect_required and enqueues nothing when the grant is dead", async () => {
    await storeConnection({ userId: "user-dead-grant", reconnectRequired: true });

    const response = await post("user-dead-grant");
    const body = (await response.json()) as ErrorEnvelope;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("reconnect_required");
    expect(body.error.message).toMatch(/reconnect/i);
    expect(await drainBells()).toStrictEqual([]);
  }, 60_000);

  it("rejects a request without a JWT and enqueues nothing", async () => {
    await storeConnection({ userId: "user-42", reconnectRequired: false });

    const response = await createSyncTriggerApp().request("/onedrive/sync-trigger", {
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(await drainBells()).toStrictEqual([]);
  }, 60_000);

  it("never reaches Microsoft, so a Sync Now cannot walk OneDrive from the API", async () => {
    await storeConnection({ userId: "user-no-graph", reconnectRequired: false });
    const fetchStub = vi.fn(() => {
      throw new Error("Sync Now must not call Microsoft: the adapter owns the walk.");
    });
    vi.stubGlobal("fetch", fetchStub);

    const response = await post("user-no-graph");

    expect(response.status).toBe(202);
    expect(fetchStub).not.toHaveBeenCalled();
  }, 60_000);
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { createCatchUpHandler } from "./catch-up.js";
import { DynamoDBTokenStore } from "./tokens/token-store-ddb.js";

const TABLE_NAME = "catch-up-vault-int";

describe("catch-up sweep against a vault holding a malformed row", () => {
  let container: StartedTestContainer;
  let client: DynamoDBDocumentClient;
  let store: DynamoDBTokenStore;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: "eu-west-2",
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .start();

    const endpoint = `http://${container.getHost()}:${container.getMappedPort(4566)}`;
    const dynamoClient = new DynamoDBClient({
      region: "eu-west-2",
      endpoint,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await dynamoClient.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
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
    client = DynamoDBDocumentClient.from(dynamoClient);
    store = new DynamoDBTokenStore({ client, tableName: TABLE_NAME, log: vi.fn() });
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("bells the healthy connection while a malformed row sits in the vault", async () => {
    // A row written by an older deploy: reconnectRequired is absent.
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
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
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: "github|healthy",
          provider: "onedrive",
          accessToken: "access-healthy",
          refreshToken: "refresh-healthy",
          expirySeconds: 1_000_000,
          updatedAt: "2026-09-01T00:00:00.000Z",
          reconnectRequired: false,
        },
      }),
    );

    const enqueue = vi.fn().mockResolvedValue(undefined);
    const handler = createCatchUpHandler({
      listConnections: () => store.list(),
      enqueue,
      now: () => 1_700_000_000_000,
    });

    await expect(handler()).resolves.toBeUndefined();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ bell: { userId: "github|healthy", provider: "onedrive" } }),
    );
  }, 30_000);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { createDeltaStateStoreDdb } from "./delta-state-store-ddb.js";

const TABLE_NAME = "delta-state-int";

describe("delta state store against LocalStack DDB", () => {
  let container: StartedTestContainer;
  let client: DynamoDBDocumentClient;
  let store: ReturnType<typeof createDeltaStateStoreDdb>;

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
    store = createDeltaStateStoreDdb({ client, tableName: TABLE_NAME });
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("write then read returns the stored deltaLink and updatedAt verbatim", async () => {
    const state = {
      deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };

    await store.write("github|roundtrip", "onedrive", state);

    await expect(store.read("github|roundtrip", "onedrive")).resolves.toEqual(state);
  });

  it("read returns null for a connection with no stored state", async () => {
    await expect(store.read("github|missing", "onedrive")).resolves.toBeNull();
  });

  it("clear removes the stored state so a reset walk starts from scratch", async () => {
    await store.write("github|reset", "onedrive", {
      deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=reset",
      updatedAt: "2026-09-01T00:00:01.000Z",
    });

    await store.clear("github|reset", "onedrive");

    await expect(store.read("github|reset", "onedrive")).resolves.toBeNull();
  });

  it("a malformed stored item is rejected by the schema on read", async () => {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { userId: "github|malformed", provider: "onedrive", deltaLink: "" },
      }),
    );

    await expect(store.read("github|malformed", "onedrive")).rejects.toBeInstanceOf(z.ZodError);
  });
});

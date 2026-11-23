import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { DynamoDBDeltaCursorStore } from "./delta-cursor-store-ddb.js";
import type { DeltaCursorStore } from "./delta-cursor-store.js";

const TABLE_NAME = "delta-tokens-int";

describe("delta cursor store against LocalStack DDB", () => {
  let container: StartedTestContainer;
  let client: DynamoDBDocumentClient;
  let store: DeltaCursorStore;

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
        KeySchema: [{ AttributeName: "profileId", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "profileId", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    client = DynamoDBDocumentClient.from(dynamoClient);
    store = new DynamoDBDeltaCursorStore({ client, tableName: TABLE_NAME });
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("write then read returns the stored deltaLink and updatedAt verbatim", async () => {
    const cursor = {
      deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };

    await store.write("profile-roundtrip", cursor);

    await expect(store.read("profile-roundtrip")).resolves.toEqual(cursor);
  }, 30_000);

  it("read returns null for a profile with no stored cursor", async () => {
    await expect(store.read("profile-missing")).resolves.toBeNull();
  }, 30_000);

  it("keeps two profiles' cursors apart, so one walk cannot resume from another's position", async () => {
    await store.write("profile-a", {
      deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=a",
      updatedAt: "2026-09-01T00:00:01.000Z",
    });
    await store.write("profile-b", {
      deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=b",
      updatedAt: "2026-09-01T00:00:02.000Z",
    });

    const cursorA = await store.read("profile-a");
    const cursorB = await store.read("profile-b");

    expect(cursorA?.deltaLink).toBe("https://graph.microsoft.com/v1.0/me/drive/root/delta?token=a");
    expect(cursorB?.deltaLink).toBe("https://graph.microsoft.com/v1.0/me/drive/root/delta?token=b");
  }, 30_000);

  it("clear removes the stored cursor so a reset walk starts from scratch", async () => {
    await store.write("profile-reset", {
      deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=reset",
      updatedAt: "2026-09-01T00:00:03.000Z",
    });

    await store.clear("profile-reset");

    await expect(store.read("profile-reset")).resolves.toBeNull();
  }, 30_000);

  it("a malformed stored cursor is rejected by the schema on read", async () => {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          profileId: "profile-malformed",
          deltaLink: "",
          updatedAt: "2026-09-01T00:00:04.000Z",
        },
      }),
    );

    await expect(store.read("profile-malformed")).rejects.toBeInstanceOf(z.ZodError);
  }, 30_000);

  it("a row without a deltaLink holds no cursor, so the legacy writer's token does not wedge a walk", async () => {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          profileId: "profile-legacy",
          deltaToken: "legacy-opaque-token",
          updatedAt: "2026-09-01T00:00:05.000Z",
        },
      }),
    );

    await expect(store.read("profile-legacy")).resolves.toBeNull();
  }, 30_000);
});

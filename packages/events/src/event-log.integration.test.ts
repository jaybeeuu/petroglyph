import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createEventLogWriter } from "./event-log.js";
import type { CloudEvent } from "./cloud-event.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const canRun = dockerAvailable();

describe.skipIf(!canRun)("event log writer against LocalStack DDB", () => {
  let container: StartedTestContainer;
  let writer: ReturnType<typeof createEventLogWriter>;
  const tableName = "event-log-int";

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
        TableName: tableName,
        KeySchema: [
          { AttributeName: "source", KeyType: "HASH" },
          { AttributeName: "id", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "source", AttributeType: "S" },
          { AttributeName: "id", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    const docClient = DynamoDBDocumentClient.from(dynamoClient);
    writer = createEventLogWriter({ client: docClient, tableName });
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("put-if-absent really gates a duplicate source+id at write time", async () => {
    const document: CloudEvent<{ profileId: string; s3Key: string }> = {
      specversion: "1.0" as const,
      id: "75bcad3e-9e61-4f2e-9f4d-1f48f723c186",
      source: "onedrive://profiles/p1",
      type: "petroglyph.file.staged",
      time: "2026-09-03T12:00:00Z",
      datacontenttype: "application/json",
      dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
      data: { profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" },
    };

    expect(await writer.putIfAbsent(document)).toBe(true);
    expect(await writer.putIfAbsent(document)).toBe(false);
  });

  it("different ids on the same source coexist", async () => {
    const base: Omit<CloudEvent<{ profileId: string; s3Key: string }>, "id"> = {
      specversion: "1.0" as const,
      source: "onedrive://profiles/p1",
      type: "petroglyph.file.staged",
      time: "2026-09-03T12:00:00Z",
      datacontenttype: "application/json",
      dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
      data: { profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" },
    };

    expect(await writer.putIfAbsent({ ...base, id: "id-1" })).toBe(true);
    expect(await writer.putIfAbsent({ ...base, id: "id-2" })).toBe(true);
    expect(await writer.putIfAbsent({ ...base, id: "id-1" })).toBe(false);
  });
});

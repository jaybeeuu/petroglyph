import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBStagedChangeLog } from "./change-log-ddb.js";
import type { StagedChangeInput } from "./change-log.js";

const CHANGES_TABLE = "staged-changes-int";

function change(overrides: Partial<StagedChangeInput> = {}): StagedChangeInput {
  return {
    profileId: "p1",
    subscriptionId: "subscription-1",
    changeId: "p1:item-1:file:etag-1",
    itemId: "item-1",
    kind: "stage",
    relativePath: "notes",
    name: "a.pdf",
    mimeType: "application/pdf",
    s3Key: "staging/v1/p1/notes/a.pdf",
    recordedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("change log against LocalStack DynamoDB", () => {
  let container: StartedTestContainer;
  let log: DynamoDBStagedChangeLog;

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
    const client = new DynamoDBClient({
      region: "eu-west-2",
      endpoint,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await client.send(
      new CreateTableCommand({
        TableName: CHANGES_TABLE,
        KeySchema: [
          { AttributeName: "profileId", KeyType: "HASH" },
          { AttributeName: "seq", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "profileId", AttributeType: "S" },
          { AttributeName: "seq", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    log = new DynamoDBStagedChangeLog({
      client: DynamoDBDocumentClient.from(client),
      tableName: CHANGES_TABLE,
    });
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("orders by seq, not by itemId, across a page that crosses the single-digit boundary", async () => {
    // Appended in an order that itemId sorting would scramble: "item-9" first,
    // then "item-10" — a lexicographic order would put 10 before 9.
    for (const itemId of ["item-9", "item-10", "item-1"]) {
      await log.append(
        change({ itemId, changeId: `p9:${itemId}:file:etag-1`, profileId: "p-order" }),
      );
    }

    const changes = await log.read({ profileId: "p-order" });

    expect(changes.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(changes.map((entry) => entry.itemId)).toEqual(["item-9", "item-10", "item-1"]);
  }, 30_000);

  it("a redelivered change appends once and burns no seq", async () => {
    await log.append(change({ profileId: "p-retry" }));
    const redelivered = await log.append(change({ profileId: "p-retry" }));
    await log.append(
      change({ profileId: "p-retry", itemId: "item-2", changeId: "p-retry:item-2:file:etag-1" }),
    );

    expect(redelivered).toEqual({ status: "duplicate" });
    const changes = await log.read({ profileId: "p-retry" });
    expect(changes.map((entry) => [entry.seq, entry.itemId])).toEqual([
      [1, "item-1"],
      [2, "item-2"],
    ]);
  }, 30_000);

  it("a re-staged item with a new eTag appends a new seq, so a cursor behind it sees it again", async () => {
    await log.append(change({ profileId: "p-restage" }));
    const first = await log.read({ profileId: "p-restage" });
    const cursor = first.at(-1)?.seq ?? 0;

    await log.append(
      change({
        profileId: "p-restage",
        changeId: "p-restage:item-1:file:etag-2",
        eTag: "etag-2",
      }),
    );

    const afterCursor = await log.read({ profileId: "p-restage", after: cursor });
    expect(afterCursor.map((entry) => [entry.seq, entry.eTag])).toEqual([[2, "etag-2"]]);
    expect(await log.read({ profileId: "p-restage", after: 2 })).toEqual([]);
  }, 30_000);

  it("pages through delete rows without gaps, and a delete row carries no content key", async () => {
    await log.append(change({ profileId: "p-delete" }));
    await log.append({
      profileId: "p-delete",
      subscriptionId: "subscription-1",
      changeId: "p-delete:item-1:deleted:",
      itemId: "item-1",
      kind: "delete",
      relativePath: "notes",
      recordedAt: "2026-09-01T00:00:00.000Z",
    });

    const firstPage = await log.read({ profileId: "p-delete", limit: 1 });
    expect(firstPage.map((entry) => entry.kind)).toEqual(["stage"]);

    const secondPage = await log.read({ profileId: "p-delete", after: 1, limit: 1 });
    expect(secondPage.map((entry) => [entry.seq, entry.kind, entry.s3Key])).toEqual([
      [2, "delete", undefined],
    ]);
  }, 30_000);

  it("keeps each profile's log separate", async () => {
    await log.append(change({ profileId: "p-a" }));
    await log.append(change({ profileId: "p-b", itemId: "item-b" }));

    const changes = await log.read({ profileId: "p-b" });

    expect(changes.map((entry) => [entry.seq, entry.itemId])).toEqual([[1, "item-b"]]);
  }, 30_000);
});

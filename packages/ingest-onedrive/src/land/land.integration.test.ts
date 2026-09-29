import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient, CreateTableCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBEventLogWriter, type EventLogWriter } from "@petroglyph/events";
import {
  createS3StagedObjectStore,
  detectType,
  fileStagedEvent,
} from "@petroglyph/staging-contracts";
import { processChange } from "./process-change.js";
import type { GraphClient } from "../tokens/graph-client.js";
import type { FileChangeEvent } from "../delta/delta-walk.js";

const BUCKET = "petroglyph-staged-pdfs";
const LOG_TABLE = "event-log-int";

const change: FileChangeEvent = {
  kind: "file",
  profileId: "p1",
  itemId: "item-1",
  name: "landed.pdf",
  relativePath: "notes",
  mimeType: "application/pdf",
};

/** A capturing wrapper: remembers each doc and the outcome the log returned. */
function capturingEventLog(
  inner: EventLogWriter,
): EventLogWriter & { docs: unknown[]; writes: boolean[] } {
  const docs: unknown[] = [];
  const writes: boolean[] = [];
  return {
    docs,
    writes,
    async putIfAbsent(document) {
      docs.push(document);
      const written = await inner.putIfAbsent(document);
      writes.push(written);
      return written;
    },
  };
}

describe("fetch+gate+land against LocalStack S3 + DDB", () => {
  let container: StartedTestContainer;
  let store: ReturnType<typeof createS3StagedObjectStore>;
  let eventLog: EventLogWriter;
  let dynamoClient: DynamoDBClient;
  let s3Client: S3Client;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb,s3",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: "eu-west-2",
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .start();

    const endpoint = `http://${container.getHost()}:${container.getMappedPort(4566)}`;
    const credentials = { accessKeyId: "test", secretAccessKey: "test" };
    s3Client = new S3Client({ region: "eu-west-2", endpoint, forcePathStyle: true, credentials });
    await s3Client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    store = createS3StagedObjectStore({ bucket: BUCKET, region: "eu-west-2", client: s3Client });

    dynamoClient = new DynamoDBClient({ region: "eu-west-2", endpoint, credentials });
    await dynamoClient.send(
      new CreateTableCommand({
        TableName: LOG_TABLE,
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
    eventLog = new DynamoDBEventLogWriter({
      client: DynamoDBDocumentClient.from(dynamoClient),
      tableName: LOG_TABLE,
    });
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("lands bytes with detected ContentType; emitted doc parses via the registry; source+id dedupes at write", async () => {
    const body = new TextEncoder().encode("%PDF-1.7\n1 0 obj");
    const graph: GraphClient = {
      request: () => Promise.resolve(new Response(body, { status: 200 })),
    };
    const log = capturingEventLog(eventLog);

    // First emission: put-if-absent writes.
    const outcome = await processChange(change, {
      graph,
      store,
      eventLog: log,
      emissionId: "emission-int-1",
    });
    expect(outcome).toBe("landed");

    const stored = await store.get("staging/v1/p1/notes/landed.pdf");
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error("expected landed object");
    expect(new TextDecoder().decode(stored.body)).toBe("%PDF-1.7\n1 0 obj");
    expect(detectType(stored.body)).toBe("application/pdf");

    // content-type invariant: event mimeType == S3 ContentType == detectType
    const head = await s3Client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: "staging/v1/p1/notes/landed.pdf" }),
    );
    expect(head.ContentType).toBe("application/pdf");

    // the emitted document parses through the registered event surface
    const emitted = log.docs[0];
    expect(() => fileStagedEvent.parse(emitted)).not.toThrow();

    // second emission with the identical source+id is deduped at write
    const outcome2 = await processChange(change, {
      graph,
      store,
      eventLog: log,
      emissionId: "emission-int-1",
    });
    expect(outcome2).toBe("deduped");
    expect(log.writes).toEqual([true, false]);

    // the registry holds exactly one row for that source+id
    const rows = await dynamoClient.send(
      new ScanCommand({
        TableName: LOG_TABLE,
        FilterExpression: "#id = :id",
        ExpressionAttributeNames: { "#id": "id" },
        ExpressionAttributeValues: { ":id": { S: "emission-int-1" } },
      }),
    );
    expect(rows.Count).toBe(1);
  });

  it("s3Key remains deterministic across a restage — same key, overwritten bytes", async () => {
    const first = new TextEncoder().encode("%PDF-1.7 first");
    const second = new TextEncoder().encode("%PDF-1.7 second");
    let current = first;
    const graph: GraphClient = {
      request: () => Promise.resolve(new Response(current, { status: 200 })),
    };
    const eventLog2 = capturingEventLog(eventLog);

    await processChange(change, { graph, store, eventLog: eventLog2, emissionId: "em-e1" });
    current = second;
    await processChange(change, { graph, store, eventLog: eventLog2, emissionId: "em-e2" });

    const stored = await store.get("staging/v1/p1/notes/landed.pdf");
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error("expected stored object");
    expect(new TextDecoder().decode(stored.body)).toBe("%PDF-1.7 second");
  });
});

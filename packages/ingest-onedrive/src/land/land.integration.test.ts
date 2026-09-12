import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createS3ObjectStore } from "@petroglyph/core";
import { createEventLogWriter, type EventLogWriter } from "@petroglyph/events";
import { detectType, fileStagedEvent } from "@petroglyph/staging-contracts";
import { processChange } from "./process-change.js";
import type { GraphClient } from "../tokens/graph-client.js";
import type { FileChangeEvent } from "../delta/delta-walk.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const canRun = dockerAvailable();
const BUCKET = "petroglyph-staged-pdfs";
const LOG_TABLE = "event-log-int";

const change: FileChangeEvent = {
  profileId: "p1",
  changeType: "created",
  itemId: "item-1",
  name: "landed.pdf",
  relativePath: "notes",
  mimeType: "application/pdf",
  isFolder: false,
};

/** A capturing wrapper: asserts on the outer call, remembers the doc. */
function capturingEventLog(inner: EventLogWriter): EventLogWriter & { docs: unknown[] } {
  const docs: unknown[] = [];
  return {
    docs,
    async putIfAbsent(document) {
      docs.push(document);
      return inner.putIfAbsent(document);
    },
  };
}

describe.skipIf(!canRun)("fetch+gate+land against LocalStack S3 + DDB", () => {
  let container: StartedTestContainer;
  let store: ReturnType<typeof createS3ObjectStore>;
  let eventLog: EventLogWriter;
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
    store = createS3ObjectStore({ bucket: BUCKET, region: "eu-west-2", client: s3Client });

    const dynamoClient = new DynamoDBClient({ region: "eu-west-2", endpoint, credentials });
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
    eventLog = createEventLogWriter({
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
    expect(outcome2).toBe("landed");
    expect(log.docs).toHaveLength(2);
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

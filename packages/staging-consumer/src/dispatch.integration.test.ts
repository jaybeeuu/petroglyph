import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import type { CloudEvent } from "@petroglyph/events";
import {
  DynamoDBStagedIndexStore,
  S3StagedObjectStore,
  type FileDeletedData,
  type FileStagedData,
} from "@petroglyph/staging-contracts";
import { createDispatchHandler, type DispatchDependencies } from "./dispatch.js";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const STAGED_RECORDS_TABLE = "staged-records-int";
const STAGED_PDFS_BUCKET = "petroglyph-staged-pdfs-int";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n%%EOF");

/** Wraps staged payloads in the CE envelope the forwarder serialises onto the queue. */
function createStagedEvent(data: FileStagedData): CloudEvent<FileStagedData> {
  return {
    specversion: "1.0",
    id: `emission-${data.profileId}-${data.itemId}`,
    source: `onedrive://profiles/${data.profileId}`,
    type: "petroglyph.file.staged",
    time: "2026-09-01T00:00:00.000Z",
    datacontenttype: "application/json",
    dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
    subject: `files/${data.itemId}`,
    data,
  };
}

function createDeletedEvent(data: FileDeletedData): CloudEvent<FileDeletedData> {
  return {
    specversion: "1.0",
    id: `emission-${data.profileId}-${data.itemId}`,
    source: `onedrive://profiles/${data.profileId}`,
    type: "petroglyph.file.deleted",
    time: "2026-09-02T00:00:00.000Z",
    datacontenttype: "application/json",
    dataschema: "https://schemas.petroglyph.dev/file-deleted/v1.json",
    subject: `files/${data.itemId}`,
    data,
  };
}

function createSqsRecord(document: CloudEvent<unknown>, messageId: string): SQSRecord {
  return {
    messageId,
    receiptHandle: `receipt-${messageId}`,
    body: JSON.stringify(document),
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "1",
      SenderId: "sender",
      ApproximateFirstReceiveTimestamp: "1",
    },
    messageAttributes: {},
    md5OfBody: "md5",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:eu-west-2:000000000000:petroglyph-staged-events-int.fifo",
    awsRegion: REGION,
  };
}

describe("dispatch handler against LocalStack staged_records + S3", () => {
  let container: StartedTestContainer | undefined;
  let index: DynamoDBStagedIndexStore;
  let objectStore: S3StagedObjectStore;
  let handler: ReturnType<typeof createDispatchHandler>;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb,s3",
        AWS_ACCESS_KEY_ID: CREDENTIALS.accessKeyId,
        AWS_SECRET_ACCESS_KEY: CREDENTIALS.secretAccessKey,
        AWS_DEFAULT_REGION: REGION,
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .withStartupTimeout(120_000)
      .start();

    const endpoint = `http://localhost:${container.getMappedPort(4566)}`;
    const dynamo = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    await dynamo.send(
      new CreateTableCommand({
        TableName: STAGED_RECORDS_TABLE,
        KeySchema: [
          { AttributeName: "profileId", KeyType: "HASH" },
          { AttributeName: "itemId", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "profileId", AttributeType: "S" },
          { AttributeName: "itemId", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );

    const s3 = new S3Client({
      region: REGION,
      endpoint,
      forcePathStyle: true,
      credentials: CREDENTIALS,
    });
    await s3.send(new CreateBucketCommand({ Bucket: STAGED_PDFS_BUCKET }));

    index = new DynamoDBStagedIndexStore({
      client: DynamoDBDocumentClient.from(dynamo),
      tableName: STAGED_RECORDS_TABLE,
    });
    objectStore = new S3StagedObjectStore({
      bucket: STAGED_PDFS_BUCKET,
      region: REGION,
      client: s3,
    });
    const dependencies: DispatchDependencies = { index, objectStore, log: () => undefined };
    handler = createDispatchHandler(dependencies);
  }, 180_000);

  afterAll(async () => {
    // Guard the handle: a rejected container.start() leaves `container`
    // undefined, and an unguarded stop() would bury the real error.
    await container?.stop();
  }, 30_000);

  it("writes a staged_records row for each staged CloudEvent in the batch", async () => {
    const response = await handler({
      Records: [
        createSqsRecord(
          createStagedEvent({
            profileId: "profile-1",
            source: "onedrive",
            changeType: "created",
            itemId: "item-1",
            name: "a.pdf",
            relativePath: "notes",
            s3Key: "staging/v1/profile-1/notes/a.pdf",
            mimeType: "application/pdf",
          }),
          "message-1",
        ),
        createSqsRecord(
          createStagedEvent({
            profileId: "profile-2",
            source: "onedrive",
            changeType: "updated",
            itemId: "item-2",
            name: "b.pdf",
            relativePath: "reports",
            s3Key: "staging/v1/profile-2/reports/b.pdf",
            mimeType: "application/pdf",
          }),
          "message-2",
        ),
      ],
    } satisfies SQSEvent);

    expect(response.batchItemFailures).toEqual([]);
    expect(await index.get("profile-1", "item-1")).toMatchObject({
      profileId: "profile-1",
      itemId: "item-1",
      s3Key: "staging/v1/profile-1/notes/a.pdf",
      name: "a.pdf",
      relativePath: "notes",
      status: "staged",
    });
    expect(await index.get("profile-2", "item-2")).toMatchObject({
      profileId: "profile-2",
      itemId: "item-2",
      s3Key: "staging/v1/profile-2/reports/b.pdf",
      status: "staged",
    });
  }, 60_000);

  it("deletes the staged S3 object and removes its row for a deleted CloudEvent", async () => {
    const s3Key = "staging/v1/profile-1/notes/a.pdf";
    await objectStore.put(s3Key, PDF_BYTES, { contentType: "application/pdf" });
    await index.upsert({
      profileId: "profile-1",
      itemId: "item-1",
      s3Key,
      relativePath: "notes",
      name: "a.pdf",
      source: "onedrive",
      mimeType: "application/pdf",
      status: "staged",
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    const response = await handler({
      Records: [
        createSqsRecord(
          createDeletedEvent({
            profileId: "profile-1",
            source: "onedrive",
            changeType: "deleted",
            itemId: "item-1",
            relativePath: "notes/a.pdf",
            s3Key,
          }),
          "message-1",
        ),
      ],
    } satisfies SQSEvent);

    expect(response.batchItemFailures).toEqual([]);
    expect(await objectStore.get(s3Key)).toBeNull();
    expect(await index.get("profile-1", "item-1")).toBeNull();
  }, 60_000);
});

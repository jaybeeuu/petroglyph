import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoDBStagedIndexStore,
  S3StagedObjectStore,
  type StagedRecord,
} from "@petroglyph/staging-contracts";
import { purgeStagedStorageForProfile } from "./profile-purge.js";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const STAGED_RECORDS_TABLE = "staged-records-purge-int";
const STAGED_PDFS_BUCKET = "petroglyph-staged-pdfs-purge-int";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n%%EOF");

function createStagedRecord(
  overrides: Partial<StagedRecord> & { profileId: string; itemId: string; s3Key: string },
): StagedRecord {
  return {
    relativePath: "notes",
    name: `${overrides.itemId}.pdf`,
    source: "onedrive",
    mimeType: "application/pdf",
    status: "staged",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("profile purge against LocalStack staged_records + S3", () => {
  let container: StartedTestContainer | undefined;
  let index: DynamoDBStagedIndexStore;
  let objectStore: S3StagedObjectStore;

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
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  }, 30_000);

  it("purges one profile's staged rows and objects and leaves the other profile whole", async () => {
    const purgedRecords = ["a", "b"].map((name) =>
      createStagedRecord({
        profileId: "profile-purged",
        itemId: `item-${name}`,
        s3Key: `staging/v1/profile-purged/notes/${name}.pdf`,
      }),
    );
    const keptRecord = createStagedRecord({
      profileId: "profile-kept",
      itemId: "item-c",
      s3Key: "staging/v1/profile-kept/notes/c.pdf",
    });
    for (const record of [...purgedRecords, keptRecord]) {
      await index.upsert(record);
      await objectStore.put(record.s3Key, PDF_BYTES, { contentType: "application/pdf" });
    }

    const outcome = await purgeStagedStorageForProfile({ index, objectStore }, "profile-purged");

    expect(outcome).toEqual({ status: "complete" });
    expect((await index.queryFeed({ profileId: "profile-purged" })).records).toEqual([]);
    for (const record of purgedRecords) {
      expect(await objectStore.get(record.s3Key)).toBeNull();
    }
    expect((await index.queryFeed({ profileId: "profile-kept" })).records).toHaveLength(1);
    expect(await objectStore.get(keptRecord.s3Key)).not.toBeNull();
  }, 60_000);

  it("purges an already-empty profile without error", async () => {
    const outcome = await purgeStagedStorageForProfile({ index, objectStore }, "profile-purged");

    expect(outcome).toEqual({ status: "complete" });
  }, 60_000);
});

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ObjectStore, SyncProfile } from "@petroglyph/core";
import { createS3ObjectStore } from "@petroglyph/core";
import { createStagedIndexStoreDdb, type StagedIndexStore } from "@petroglyph/staging-consumer";
import { Hono } from "hono";
import { createFilesRouter, type FilesRouterVariables } from "./app.js";

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
const RECORDS_TABLE = "file-records-int";

const profile: SyncProfile = {
  profileId: "p1",
  userId: "user-1",
  name: "Main",
  sourceFolderPath: "notes",
  destinationVaultPath: "Inbox",
  pollingIntervalMinutes: 5,
  enabled: true,
  active: true,
  initialSyncEnabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe.skipIf(!canRun)("delivery surface /files against LocalStack S3 + DDB", () => {
  let container: StartedTestContainer;
  let index: StagedIndexStore;
  let objectStore: ObjectStore;
  let app: Hono<{ Variables: FilesRouterVariables }>;

  const S3_KEY = "staging/v1/p1/notes/a.pdf";
  const BODY = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n%%EOF");

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

    const s3Client = new S3Client({
      region: "eu-west-2",
      endpoint,
      forcePathStyle: true,
      credentials,
    });
    await s3Client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    objectStore = createS3ObjectStore({ bucket: BUCKET, region: "eu-west-2", client: s3Client });

    const dynamoClient = new DynamoDBClient({ region: "eu-west-2", endpoint, credentials });
    await dynamoClient.send(
      new CreateTableCommand({
        TableName: RECORDS_TABLE,
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
    index = createStagedIndexStoreDdb({
      client: DynamoDBDocumentClient.from(dynamoClient),
      tableName: RECORDS_TABLE,
    });

    const router = createFilesRouter({
      index,
      objectStore,
      listProfiles: () => Promise.resolve([{ ...profile }]),
    });
    app = new Hono<{ Variables: FilesRouterVariables }>();
    app.use("*", async (c, next) => {
      c.set("userId", "user-1");
      await next();
    });
    app.route("/", router);
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("M6: feed-issued presigned GET downloads the real object with a filename override", async () => {
    await index.upsert({
      profileId: "p1",
      itemId: "item-1",
      s3Key: S3_KEY,
      relativePath: "notes",
      name: "a.pdf",
      source: "onedrive",
      mimeType: "application/pdf",
      status: "staged",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    await objectStore.put(S3_KEY, BODY, { contentType: "application/pdf" });

    const res = await app.request("/files");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { itemId: string; s3PresignedUrl: string }[] };
    expect(body.files).toHaveLength(1);
    expect(body.files[0]?.itemId).toBe("item-1");

    const url = body.files[0]?.s3PresignedUrl ?? "";
    // The presign target is the STORED key, verbatim — never derived.
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      // LocalStack addresses buckets path-style: bucket and key sit in the path.
      expect(parsed.pathname).toBe(`/${BUCKET}/${S3_KEY}`);
    } else {
      // Real AWS virtual-hosts the bucket: the bucket root is the host.
      expect(parsed.pathname).toBe(`/${S3_KEY}`);
    }

    const downloaded = await fetch(url);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(BODY);
    expect(downloaded.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''a.pdf",
    );
  });

  it("M2/M7: a deleted record is never served — feed drops it, download 404s", async () => {
    const afterDelete = await app.request("/files");
    const body = (await afterDelete.json()) as { files: unknown[] };
    expect(body.files).toHaveLength(1);

    await index.remove("p1", "item-1");

    const feed = await app.request("/files");
    const feedBody = (await feed.json()) as { files: unknown[] };
    expect(feedBody.files).toEqual([]);

    const download = await app.request("/files/item-1");
    expect(download.status).toBe(404);
  });

  it("M5: a record under a foreign profile is never served, even when bytes exist", async () => {
    await index.upsert({
      profileId: "p-other",
      itemId: "item-9",
      s3Key: "staging/v1/p-other/inbox/secret.pdf",
      relativePath: "inbox",
      name: "secret.pdf",
      source: "onedrive",
      mimeType: "application/pdf",
      status: "staged",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    await objectStore.put("staging/v1/p-other/inbox/secret.pdf", BODY, {
      contentType: "application/pdf",
    });

    expect((await app.request("/files/item-9")).status).toBe(404);
    const feed = await app.request("/files");
    const feedBody = (await feed.json()) as { files: unknown[] };
    expect(feedBody.files).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SyncProfile } from "@petroglyph/core";
import {
  DynamoDBStagedChangeLog,
  DynamoDBStagedIndexStore,
  S3StagedObjectStore,
  type StagedChangeLog,
  type StagedIndexStore,
  type StagedObjectStore,
} from "@petroglyph/staging-contracts";
import { Hono } from "hono";
import { createFilesRouter, type FilesRouterVariables } from "./app.js";

const BUCKET = "petroglyph-staged-pdfs";
const RECORDS_TABLE = "file-records-int";
const CHANGES_TABLE = "staged-changes-int";

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

interface FeedBody {
  files: { itemId: string; name: string; s3PresignedUrl: string }[];
  nextToken: string | null;
}

describe("delivery surface /files against LocalStack S3 + DDB", () => {
  let container: StartedTestContainer;
  let index: StagedIndexStore;
  let changeLog: StagedChangeLog;
  let objectStore: StagedObjectStore;
  let app: Hono<{ Variables: FilesRouterVariables }>;

  const S3_KEY = "staging/v1/p1/notes/a.pdf";
  const BODY = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n%%EOF");

  /** A delivery app scoped to one profile, so a test owns its own change log. */
  function appFor(profileId: string): Hono<{ Variables: FilesRouterVariables }> {
    const scoped = new Hono<{ Variables: FilesRouterVariables }>();
    scoped.use("*", async (c, next) => {
      c.set("userId", "user-1");
      await next();
    });
    scoped.route(
      "/",
      createFilesRouter({
        index,
        changeLog,
        objectStore,
        listProfiles: () => Promise.resolve([{ ...profile, profileId }]),
      }),
    );
    return scoped;
  }

  /**
   * One staged revision, as the consumer applies it: the record is the current
   * bytes, the log row is the change the client is told about.
   */
  async function stage(options: {
    profileId: string;
    itemId: string;
    eTag: string;
    name?: string;
    relativePath?: string;
    s3Key?: string;
    body?: Uint8Array;
  }): Promise<void> {
    const relativePath = options.relativePath ?? "notes";
    const name = options.name ?? "a.pdf";
    const s3Key = options.s3Key ?? `staging/v1/${options.profileId}/${relativePath}/${name}`;
    await objectStore.put(s3Key, options.body ?? BODY, { contentType: "application/pdf" });
    await index.upsert({
      profileId: options.profileId,
      subscriptionId: options.profileId,
      itemId: options.itemId,
      s3Key,
      relativePath,
      name,
      source: "onedrive",
      mimeType: "application/pdf",
      status: "staged",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    await changeLog.append({
      profileId: options.profileId,
      subscriptionId: options.profileId,
      changeId: `${options.profileId}:${options.itemId}:file:${options.eTag}`,
      itemId: options.itemId,
      kind: "stage",
      relativePath,
      name,
      mimeType: "application/pdf",
      s3Key,
      eTag: options.eTag,
      recordedAt: "2026-09-01T00:00:00.000Z",
    });
  }

  async function fetchPage(
    target: Hono<{ Variables: FilesRouterVariables }>,
    nextToken: string | null,
    limit?: number,
  ): Promise<FeedBody> {
    const params = [limit === undefined ? "" : `limit=${String(limit)}`];
    if (nextToken !== null) params.push(`nextToken=${encodeURIComponent(nextToken)}`);
    const query = params.filter((part) => part !== "").join("&");
    const response = await target.request(`/files${query === "" ? "" : `?${query}`}`);
    expect(response.status).toBe(200);
    return (await response.json()) as FeedBody;
  }

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
    objectStore = new S3StagedObjectStore({
      bucket: BUCKET,
      region: "eu-west-2",
      client: s3Client,
    });

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
    await dynamoClient.send(
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
    const documentClient = DynamoDBDocumentClient.from(dynamoClient);
    index = new DynamoDBStagedIndexStore({ client: documentClient, tableName: RECORDS_TABLE });
    changeLog = new DynamoDBStagedChangeLog({ client: documentClient, tableName: CHANGES_TABLE });

    app = appFor("p1");
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("M6: feed-issued presigned GET downloads the real object with a filename override", async () => {
    await stage({ profileId: "p1", itemId: "item-1", eTag: "etag-1" });

    const feed = await fetchPage(app, null);
    expect(feed.files).toHaveLength(1);
    expect(feed.files[0]?.itemId).toBe("item-1");

    const url = feed.files[0]?.s3PresignedUrl ?? "";
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
  }, 30_000);

  it("M2/M7: a deleted record is never served — feed drops it, download 404s", async () => {
    const feed = await fetchPage(app, null);
    expect(feed.files).toHaveLength(1);

    await index.remove("p1", "item-1");

    const afterDelete = await fetchPage(app, null);
    expect(afterDelete.files).toEqual([]);

    const download = await app.request("/files/item-1");
    expect(download.status).toBe(404);
  }, 30_000);

  it("M5: a record under a foreign profile is never served, even when bytes exist", async () => {
    await stage({
      profileId: "p-other",
      itemId: "item-9",
      eTag: "etag-1",
      name: "secret.pdf",
      relativePath: "inbox",
    });

    expect((await app.request("/files/item-9")).status).toBe(404);
    const feed = await fetchPage(app, null);
    expect(feed.files).toEqual([]);
  }, 30_000);

  it("serves a re-staged item again to a client whose cursor is behind it, then reports caught up", async () => {
    const target = appFor("p-restage");
    await stage({ profileId: "p-restage", itemId: "item-1", eTag: "etag-1" });

    const first = await fetchPage(target, null, 1);
    expect(first.files.map((file) => file.itemId)).toEqual(["item-1"]);
    if (first.nextToken === null) throw new Error("expected a cursor after the first page");

    await stage({ profileId: "p-restage", itemId: "item-1", eTag: "etag-2" });

    const second = await fetchPage(target, first.nextToken, 1);
    expect(second.files.map((file) => file.itemId)).toEqual(["item-1"]);
    expect(second.files[0]?.name).toBe("a.pdf");

    const caughtUp = await fetchPage(target, second.nextToken, 1);
    expect(caughtUp.files).toEqual([]);
    expect(caughtUp.nextToken).toBeNull();
  }, 30_000);

  it("orders the feed by seq — an item appended last is served last, whatever its itemId", async () => {
    const target = appFor("p-order");
    await stage({ profileId: "p-order", itemId: "item-9", eTag: "etag-1", name: "nine.pdf" });
    await stage({ profileId: "p-order", itemId: "item-10", eTag: "etag-1", name: "ten.pdf" });

    const feed = await fetchPage(target, null);

    expect(feed.files.map((file) => file.itemId)).toEqual(["item-9", "item-10"]);
  }, 30_000);

  it("keeps a client cursor valid when the server discards its delta state and re-enumerates", async () => {
    const target = appFor("p-delta-reset");
    await stage({ profileId: "p-delta-reset", itemId: "item-1", eTag: "etag-1" });

    const first = await fetchPage(target, null, 1);
    expect(first.files.map((file) => file.itemId)).toEqual(["item-1"]);
    if (first.nextToken === null) throw new Error("expected a cursor after the first page");

    // The delta token is discarded and the root re-enumerated: unchanged bytes
    // are skipped, so no change is logged and no seq moves. The client's cursor
    // still means what it meant — it is not invalidated and nothing is replayed.
    const afterReset = await fetchPage(target, first.nextToken, 1);
    expect(afterReset.files).toEqual([]);
    expect(afterReset.nextToken).toBeNull();

    // The same cursor resumes the next real change.
    await stage({ profileId: "p-delta-reset", itemId: "item-1", eTag: "etag-2" });
    const resumed = await fetchPage(target, first.nextToken, 1);
    expect(resumed.files.map((file) => file.itemId)).toEqual(["item-1"]);
  }, 30_000);

  it("advances past a delete row without serving it or leaking a provider token", async () => {
    const target = appFor("p-delete");
    await stage({ profileId: "p-delete", itemId: "item-1", eTag: "etag-1" });
    await changeLog.append({
      profileId: "p-delete",
      subscriptionId: "p-delete",
      changeId: "p-delete:item-1:deleted:",
      itemId: "item-1",
      kind: "delete",
      relativePath: "notes",
      name: "a.pdf",
      recordedAt: "2026-09-01T00:00:01.000Z",
    });
    await index.remove("p-delete", "item-1");

    const first = await fetchPage(target, null, 1);
    const second = await fetchPage(target, first.nextToken, 1);

    expect(second.files).toEqual([]);
    expect(second.nextToken).not.toBeNull();
    // The delta token is the server's own business: no response field may carry
    // the provider's cursor, its next link, or an eTag standing in for either.
    expect(JSON.stringify([first, second])).not.toMatch(/deltaLink|nextLink|eTag/i);
  }, 30_000);
});

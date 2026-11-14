import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { deltaTriggerSchema, type DeltaTrigger } from "@petroglyph/contracts";
import type { SyncProfile } from "@petroglyph/core";
import { DynamoDBStagedIndexStore, S3StagedObjectStore } from "@petroglyph/staging-contracts";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { resetKeyCache } from "./jwt.js";
import {
  createChangeTokenClear,
  createProfilePathReset,
  type ProfilePathResetDeps,
} from "./profile-path-reset.js";
import { createSyncTriggerEnqueuer } from "./sync-trigger.js";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const ACCOUNT_ID = "000000000000";
const BUCKET = "petroglyph-staged-pdfs";
const PROFILES_TABLE = "petroglyph-sync-profiles-reset";
const STAGED_RECORDS_TABLE = "petroglyph-staged-records-reset";
const DELTA_STATES_TABLE = "petroglyph-delta-states-reset";
const QUEUE_NAME = "petroglyph-delta-trigger-reset";

const USER_ID = "user-42";
const PROFILE_ID = "profile-1";
const STORED_PATH = "onyx/NoteAir5C";
const STORED_DELTA_LINK = "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=old";

describe("PUT /profiles/:id against LocalStack staged records, S3 and FIFO SQS", () => {
  let container: StartedTestContainer;
  let dynamo: DynamoDBDocumentClient;
  let s3: S3Client;
  let sqs: SQSClient;
  let queueUrl: string;
  let sqsEndpoint: string;
  let queueOrdinal = 0;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb,s3,sqs",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: REGION,
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .withStartupTimeout(120_000)
      .start();

    const endpoint = `http://localhost:${container.getMappedPort(4566)}`;
    sqsEndpoint = endpoint;
    const rawDynamo = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    await createTable(rawDynamo, PROFILES_TABLE, "userId", "profileId");
    await createTable(rawDynamo, STAGED_RECORDS_TABLE, "profileId", "itemId");
    await createTable(rawDynamo, DELTA_STATES_TABLE, "userId", "provider");
    dynamo = DynamoDBDocumentClient.from(rawDynamo);

    s3 = new S3Client({ region: REGION, endpoint, forcePathStyle: true, credentials: CREDENTIALS });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));

    sqs = new SQSClient({ region: REGION, endpoint, credentials: CREDENTIALS });

    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    vi.stubEnv("JWT_PUBLIC_KEY", await exportSPKI(keyPair.publicKey));
    // The profile route reads and writes through the API's own document client,
    // so point every one of them at LocalStack before the first request builds it.
    vi.stubEnv("AWS_ENDPOINT_URL_DYNAMODB", endpoint);
    vi.stubEnv("AWS_ACCESS_KEY_ID", CREDENTIALS.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", CREDENTIALS.secretAccessKey);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("SYNC_PROFILES_TABLE", PROFILES_TABLE);
    resetKeyCache();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    vi.unstubAllEnvs();
    resetKeyCache();
  }, 30_000);

  beforeEach(async () => {
    // A fresh queue per test, and a fresh name for it: SQS drops a second
    // message carrying a deduplication id it has already seen, and it remembers
    // that id for five minutes after the message itself is gone. Every reset
    // bells the same connection, so a merely drained queue would still swallow
    // the bell of a test that ran after one that had already belled.
    queueOrdinal += 1;
    const queueName = `${QUEUE_NAME}-${queueOrdinal}.fifo`;
    queueUrl = `${sqsEndpoint}/${ACCOUNT_ID}/${queueName}`;
    await sqs.send(
      new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: "true" } }),
    );
  }, 30_000);

  /**
   * The app under test: the deployed reset, but with LocalStack-backed stores
   * and the real FIFO enqueuer. No Graph client exists anywhere in the API, so
   * a 200 here is proof the request did not walk the drive.
   */
  function createResetApp(
    deps: ProfilePathResetDeps = createResetDeps(),
  ): ReturnType<typeof createApp> {
    return createApp({
      syncTrigger: {
        readConnection: () => Promise.resolve(null),
        enqueueDeltaTrigger: createSyncTriggerEnqueuer(sqs, () => queueUrl),
      },
      profilePathReset: createProfilePathReset(deps),
    });
  }

  function createResetDeps(overrides: Partial<ProfilePathResetDeps> = {}): ProfilePathResetDeps {
    return {
      stagedIndex: () =>
        new DynamoDBStagedIndexStore({ client: dynamo, tableName: STAGED_RECORDS_TABLE }),
      stagedObjects: () => new S3StagedObjectStore({ bucket: BUCKET, region: REGION, client: s3 }),
      clearChangeToken: createChangeTokenClear(dynamo, () => DELTA_STATES_TABLE),
      enqueueDeltaTrigger: createSyncTriggerEnqueuer(sqs, () => queueUrl),
      ...overrides,
    };
  }

  async function makeToken(userId = USER_ID): Promise<string> {
    return new SignJWT({ username: "octocat" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(userId)
      .setIssuer("petroglyph-api")
      .setAudience("petroglyph-plugin")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  function makeProfile(overrides: Partial<SyncProfile> = {}): SyncProfile {
    return {
      profileId: PROFILE_ID,
      userId: USER_ID,
      name: "Notebooks",
      sourceFolderPath: STORED_PATH,
      destinationVaultPath: "Inbox",
      pollingIntervalMinutes: 5,
      enabled: true,
      active: true,
      initialSyncEnabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      ...overrides,
    };
  }

  /** One staged record plus the object it names, as the dispatch lambda writes them. */
  async function stageFile(itemId: string): Promise<void> {
    const s3Key = `staging/v1/${PROFILE_ID}/${STORED_PATH}/${itemId}.pdf`;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: new TextEncoder().encode("%PDF-1.7"),
      }),
    );
    await dynamo.send(
      new PutCommand({
        TableName: STAGED_RECORDS_TABLE,
        Item: {
          profileId: PROFILE_ID,
          itemId,
          s3Key,
          relativePath: STORED_PATH,
          name: `${itemId}.pdf`,
          source: `onedrive://profiles/${PROFILE_ID}`,
          mimeType: "application/pdf",
          status: "staged",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
  }

  async function storeChangeToken(deltaLink: string): Promise<void> {
    await dynamo.send(
      new PutCommand({
        TableName: DELTA_STATES_TABLE,
        Item: {
          userId: USER_ID,
          provider: "onedrive",
          deltaLink,
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
  }

  async function putProfile(
    body: unknown,
    deps: ProfilePathResetDeps = createResetDeps(),
  ): Promise<Response> {
    return createResetApp(deps).request(`/profiles/${PROFILE_ID}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${await makeToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async function stagedItemIds(): Promise<(string | undefined)[]> {
    const rows = await dynamo.send(
      new QueryCommand({
        TableName: STAGED_RECORDS_TABLE,
        KeyConditionExpression: "profileId = :profileId",
        ExpressionAttributeValues: { ":profileId": PROFILE_ID },
      }),
    );
    return (rows.Items ?? []).map((item) => item["itemId"] as string | undefined);
  }

  async function objectExists(key: string): Promise<boolean> {
    try {
      await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async function storedChangeToken(): Promise<unknown> {
    const row = await dynamo.send(
      new GetCommand({
        TableName: DELTA_STATES_TABLE,
        Key: { userId: USER_ID, provider: "onedrive" },
      }),
    );
    return row.Item;
  }

  async function storedProfile(): Promise<SyncProfile | undefined> {
    const row = await dynamo.send(
      new GetCommand({
        TableName: PROFILES_TABLE,
        Key: { userId: USER_ID, profileId: PROFILE_ID },
      }),
    );
    return row.Item as SyncProfile | undefined;
  }

  async function drainBells(): Promise<DeltaTrigger[]> {
    const bells: DeltaTrigger[] = [];
    for (;;) {
      const received = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      if (received.Messages === undefined || received.Messages.length === 0) {
        return bells;
      }
      for (const message of received.Messages) {
        bells.push(deltaTriggerSchema.parse(JSON.parse(message.Body ?? "")));
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }
  }

  it("narrowing the source folder leaves no staged record, no staged object and no change token, and bells the adapter", async () => {
    await dynamo.send(new PutCommand({ TableName: PROFILES_TABLE, Item: makeProfile() }));
    await stageFile("item-1");
    await stageFile("item-2");
    await storeChangeToken(STORED_DELTA_LINK);

    const response = await putProfile({ sourceFolderPath: `${STORED_PATH}/Notebooks` });

    if (response.status !== 200) {
      throw new Error(`expected 200, got ${response.status}: ${await response.text()}`);
    }
    expect(await stagedItemIds()).toEqual([]);
    expect(await objectExists(`staging/v1/${PROFILE_ID}/${STORED_PATH}/item-1.pdf`)).toBe(false);
    expect(await objectExists(`staging/v1/${PROFILE_ID}/${STORED_PATH}/item-2.pdf`)).toBe(false);
    expect(await storedChangeToken()).toBeUndefined();
    // The marker the next walk honours, stored with the profile it belongs to.
    expect(await storedProfile()).toMatchObject({
      sourceFolderPath: `${STORED_PATH}/Notebooks`,
      deltaResetPending: true,
    });
    // A request that walked the drive inline could not answer 200 with no Graph
    // anywhere in this process; one bell is all the adapter is asked for.
    expect(await drainBells()).toEqual([{ userId: USER_ID, provider: "onedrive" }]);
  }, 30_000);

  it("changing only the name resets nothing and bells nothing", async () => {
    await dynamo.send(new PutCommand({ TableName: PROFILES_TABLE, Item: makeProfile() }));
    await stageFile("item-1");
    await storeChangeToken(STORED_DELTA_LINK);

    const response = await putProfile({ name: "Renamed" });

    expect(response.status).toBe(200);
    expect(await stagedItemIds()).toEqual(["item-1"]);
    expect(await objectExists(`staging/v1/${PROFILE_ID}/${STORED_PATH}/item-1.pdf`)).toBe(true);
    expect(await storedChangeToken()).toMatchObject({ deltaLink: STORED_DELTA_LINK });
    expect(await storedProfile()).toMatchObject({ name: "Renamed" });
    expect((await storedProfile())?.deltaResetPending).toBeUndefined();
    expect(await drainBells()).toEqual([]);
  }, 30_000);

  it("a failed staged-object delete leaves the records gone and the marker set, so the next walk still starts over", async () => {
    await dynamo.send(new PutCommand({ TableName: PROFILES_TABLE, Item: makeProfile() }));
    await stageFile("item-1");
    await storeChangeToken(STORED_DELTA_LINK);
    const failingObjects = {
      put: () => Promise.reject(new Error("unused")),
      get: () => Promise.resolve(null),
      delete: () => Promise.reject(new Error("s3 unavailable")),
      deleteMany: () => Promise.reject(new Error("s3 unavailable")),
      presignGet: () => Promise.reject(new Error("unused")),
    };

    const response = await putProfile(
      { sourceFolderPath: `${STORED_PATH}/Notebooks` },
      createResetDeps({ stagedObjects: () => failingObjects }),
    );

    // A reset that cannot finish must not report success.
    expect(response.status).toBe(500);
    // Records first: no record is left naming an object that may be missing.
    expect(await stagedItemIds()).toEqual([]);
    // The profile keeps what it was asked to do, so the next walk enumerates
    // again instead of resuming a token that never saw the new folder.
    expect(await storedProfile()).toMatchObject({
      sourceFolderPath: `${STORED_PATH}/Notebooks`,
      deltaResetPending: true,
    });
    expect(await storedChangeToken()).toMatchObject({ deltaLink: STORED_DELTA_LINK });
    expect(await drainBells()).toEqual([]);
  }, 30_000);

  it("a reset that failed is finished by resending the same request, because the marker keeps the reset owed", async () => {
    await dynamo.send(new PutCommand({ TableName: PROFILES_TABLE, Item: makeProfile() }));
    await stageFile("item-1");
    await stageFile("item-2");
    await storeChangeToken(STORED_DELTA_LINK);
    // The first sweep fails with nothing deleted, which is the state a killed
    // invocation leaves behind: the profile already holds the new path, so the
    // repeat is "not a change" and only the stored marker can re-drive it.
    const index = new DynamoDBStagedIndexStore({
      client: dynamo,
      tableName: STAGED_RECORDS_TABLE,
    });
    vi.spyOn(index, "removeMany").mockRejectedValueOnce(new Error("index unavailable"));
    const deps = createResetDeps({ stagedIndex: () => index });

    const failed = await putProfile({ sourceFolderPath: `${STORED_PATH}/Notebooks` }, deps);
    expect(failed.status).toBe(500);
    expect(await stagedItemIds()).toEqual(["item-1", "item-2"]);
    expect(await storedProfile()).toMatchObject({
      sourceFolderPath: `${STORED_PATH}/Notebooks`,
      deltaResetPending: true,
    });
    expect(await drainBells()).toEqual([]);

    const retried = await putProfile({ sourceFolderPath: `${STORED_PATH}/Notebooks` }, deps);

    expect(retried.status).toBe(200);
    expect(await stagedItemIds()).toEqual([]);
    expect(await objectExists(`staging/v1/${PROFILE_ID}/${STORED_PATH}/item-1.pdf`)).toBe(false);
    expect(await objectExists(`staging/v1/${PROFILE_ID}/${STORED_PATH}/item-2.pdf`)).toBe(false);
    expect(await storedChangeToken()).toBeUndefined();
    expect(await drainBells()).toEqual([{ userId: USER_ID, provider: "onedrive" }]);
  }, 30_000);

  it("discards a profile bigger than one attempt over two requests, and reports each attempt honestly", async () => {
    await dynamo.send(new PutCommand({ TableName: PROFILES_TABLE, Item: makeProfile() }));
    await stageFile("item-1");
    await stageFile("item-2");
    await stageFile("item-3");
    await storeChangeToken(STORED_DELTA_LINK);
    // Two records per attempt stands in for the 2000 the deployed reset takes:
    // same loop, same bound, at a scale LocalStack can stage quickly.
    const deps = createResetDeps({ recordBudget: 2 });

    const first = await putProfile({ sourceFolderPath: `${STORED_PATH}/Notebooks` }, deps);

    // A sweep that did not finish must not answer 200, and it must not drop the
    // token or bell a walk that would then find half the old state still served.
    expect(first.status).toBe(503);
    expect(await stagedItemIds()).toEqual(["item-3"]);
    expect(await objectExists(`staging/v1/${PROFILE_ID}/${STORED_PATH}/item-1.pdf`)).toBe(false);
    expect(await objectExists(`staging/v1/${PROFILE_ID}/${STORED_PATH}/item-3.pdf`)).toBe(true);
    expect(await storedProfile()).toMatchObject({ deltaResetPending: true });
    expect(await storedChangeToken()).toMatchObject({ deltaLink: STORED_DELTA_LINK });
    expect(await drainBells()).toEqual([]);

    const second = await putProfile({ sourceFolderPath: `${STORED_PATH}/Notebooks` }, deps);

    expect(second.status).toBe(200);
    expect(await stagedItemIds()).toEqual([]);
    expect(await objectExists(`staging/v1/${PROFILE_ID}/${STORED_PATH}/item-3.pdf`)).toBe(false);
    expect(await storedChangeToken()).toBeUndefined();
    expect(await drainBells()).toEqual([{ userId: USER_ID, provider: "onedrive" }]);
  }, 30_000);

  it("reports 500 and bells nothing when the staged index cannot be read", async () => {
    await dynamo.send(new PutCommand({ TableName: PROFILES_TABLE, Item: makeProfile() }));
    await storeChangeToken(STORED_DELTA_LINK);
    const brokenIndex = {
      upsert: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
      removeMany: () => Promise.resolve(),
      listUnderPath: () => Promise.resolve([]),
      removeUnderPath: () => Promise.resolve(),
      queryFeed: () => Promise.reject(new Error("index unavailable")),
    };

    const response = await putProfile(
      { sourceFolderPath: `${STORED_PATH}/Notebooks` },
      createResetDeps({ stagedIndex: () => brokenIndex }),
    );

    expect(response.status).toBe(500);
    expect(await storedChangeToken()).toMatchObject({ deltaLink: STORED_DELTA_LINK });
    expect(await drainBells()).toEqual([]);
  }, 30_000);
});

function createTable(
  client: DynamoDBClient,
  tableName: string,
  hashKey: string,
  rangeKey: string,
): Promise<void> {
  return client
    .send(
      new CreateTableCommand({
        TableName: tableName,
        KeySchema: [
          { AttributeName: hashKey, KeyType: "HASH" },
          { AttributeName: rangeKey, KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: hashKey, AttributeType: "S" },
          { AttributeName: rangeKey, AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    )
    .then(() => undefined);
}

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateBucketCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { SyncProfile } from "@petroglyph/core";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const BUCKET = "petroglyph-staged-pdfs";
const TOKEN_VAULT_TABLE = "token-vaults-int";
const PROFILES_TABLE = "sync-profiles-int";
const EVENT_LOG_TABLE = "event-log-int";
const DELTA_STATES_TABLE = "delta-states-int";
const CLIENT_ID_PATH = "/petroglyph/onedrive/client-id";
const CLIENT_SECRET_PATH = "/petroglyph/onedrive/client-secret";

const CONNECTION = { userId: "user-1", provider: "onedrive" };
const PROFILE: SyncProfile = {
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
const ITEM_ID = "item-1";
const S3_KEY = "staging/v1/p1/notes/a.pdf";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n%%EOF");

function deltaPage(baseUrl: string): string {
  return JSON.stringify({
    value: [
      {
        id: ITEM_ID,
        name: "a.pdf",
        eTag: "etag-1",
        parentReference: { path: "/drive/root:/notes" },
        file: { mimeType: "application/pdf" },
      },
    ],
    "@odata.deltaLink": `${baseUrl}/me/drive/root/delta?token=next`,
  });
}

/** A minimal but complete SQS trigger record — the deployed per-connection bell. */
function deltaTriggerEvent(body: { userId: string; provider: string }): SQSEvent {
  return {
    Records: [
      {
        messageId: "11111111-1111-1111-1111-111111111111",
        receiptHandle: "receipt-1",
        body: JSON.stringify(body),
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1757000000000",
          SenderId: "sender",
          ApproximateFirstReceiveTimestamp: "1757000000000",
        },
        messageAttributes: {},
        md5OfBody: "d41d8cd98f00b204e9800998ecf8427e",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:eu-west-2:000000000000:petroglyph-delta-bell-int.fifo",
        awsRegion: REGION,
      },
    ],
  };
}

describe("adapter handler against LocalStack S3 + event log", () => {
  let container: StartedTestContainer;
  let graph: { server: Server; baseUrl: string };
  let dynamo: DynamoDBDocumentClient;
  let s3: S3Client;
  let handler: (event: SQSEvent) => Promise<SQSBatchResponse>;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb,s3,ssm",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: REGION,
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .withStartupTimeout(120_000)
      .start();

    const endpoint = `http://localhost:${container.getMappedPort(4566)}`;
    const s3Endpoint = `http://s3.localhost.localstack.cloud:${container.getMappedPort(4566)}`;
    // The adapter composes its own clients from the environment; these redirect
    // every one of them at LocalStack before the handler module is imported.
    vi.stubEnv("AWS_ENDPOINT_URL_DYNAMODB", endpoint);
    vi.stubEnv("AWS_ENDPOINT_URL_S3", s3Endpoint);
    vi.stubEnv("AWS_ENDPOINT_URL_SSM", endpoint);
    vi.stubEnv("AWS_ACCESS_KEY_ID", CREDENTIALS.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", CREDENTIALS.secretAccessKey);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("REFRESH_TOKENS_TABLE", TOKEN_VAULT_TABLE);
    vi.stubEnv("SYNC_PROFILES_TABLE", PROFILES_TABLE);
    vi.stubEnv("EVENT_LOG_TABLE", EVENT_LOG_TABLE);
    vi.stubEnv("DELTA_TOKENS_TABLE", DELTA_STATES_TABLE);
    vi.stubEnv("STAGED_PDFS_BUCKET", BUCKET);
    vi.stubEnv("ONEDRIVE_CLIENT_ID_SSM_PATH", CLIENT_ID_PATH);
    vi.stubEnv("ONEDRIVE_CLIENT_SECRET_SSM_PATH", CLIENT_SECRET_PATH);

    const rawDynamo = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    await createTable(rawDynamo, TOKEN_VAULT_TABLE, "userId", "provider");
    await createTable(rawDynamo, PROFILES_TABLE, "userId", "profileId");
    await createTable(rawDynamo, EVENT_LOG_TABLE, "source", "id");
    await createTable(rawDynamo, DELTA_STATES_TABLE, "userId", "provider");
    dynamo = DynamoDBDocumentClient.from(rawDynamo);

    s3 = new S3Client({ region: REGION, endpoint, forcePathStyle: true, credentials: CREDENTIALS });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));

    const ssm = new SSMClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    await ssm.send(
      new PutParameterCommand({
        Name: CLIENT_ID_PATH,
        Value: "client-id",
        Type: "String",
        Overwrite: true,
      }),
    );
    await ssm.send(
      new PutParameterCommand({
        Name: CLIENT_SECRET_PATH,
        Value: "client-secret",
        Type: "String",
        Overwrite: true,
      }),
    );

    await dynamo.send(
      new PutCommand({
        TableName: TOKEN_VAULT_TABLE,
        Item: {
          userId: CONNECTION.userId,
          provider: CONNECTION.provider,
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expirySeconds: Math.floor(Date.now() / 1000) + 3600,
          updatedAt: "2026-09-01T00:00:00.000Z",
          reconnectRequired: false,
        },
      }),
    );
    await dynamo.send(new PutCommand({ TableName: PROFILES_TABLE, Item: PROFILE }));

    graph = await startGraphStub();
    vi.stubEnv("GRAPH_BASE_URL", graph.baseUrl);
    vi.stubEnv(
      "GRAPH_DRIVE_ROOT_DELTA_URL",
      `${graph.baseUrl}/me/drive/root/delta?$select=id,name,eTag`,
    );

    ({ handler } = await import("./lambda.js"));
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    await new Promise<void>((resolve, reject) => {
      graph.server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    vi.unstubAllEnvs();
  }, 30_000);

  it("lands the delta-found PDF in S3 and emits the staged CloudEvent to the event log", async () => {
    const response = await handler(deltaTriggerEvent(CONNECTION));

    expect(response.batchItemFailures).toEqual([]);

    const downloaded = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: S3_KEY }));
    const body = downloaded.Body;
    if (body === undefined) throw new Error("staged object returned no body");
    expect(new Uint8Array(await body.transformToByteArray())).toEqual(PDF_BYTES);

    const rows = await dynamo.send(new ScanCommand({ TableName: EVENT_LOG_TABLE }));
    expect(rows.Items).toHaveLength(1);
    const row = rows.Items?.[0];
    expect(JSON.parse(String(row?.["doc"]))).toMatchObject({
      source: "onedrive://profiles/p1",
      type: "petroglyph.file.staged",
      data: {
        profileId: "p1",
        itemId: ITEM_ID,
        name: "a.pdf",
        relativePath: "notes",
        s3Key: S3_KEY,
        mimeType: "application/pdf",
      },
    });
  }, 60_000);
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

async function startGraphStub(): Promise<{ server: Server; baseUrl: string }> {
  let baseUrl = "http://127.0.0.1";
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path.includes(`/me/drive/items/${ITEM_ID}/content`)) {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(PDF_BYTES);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(deltaPage(baseUrl));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1.0`;
  return { server, baseUrl };
}

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import {
  CreateTableCommand,
  DynamoDBClient,
  KeyType,
  ScalarAttributeType,
  type AttributeDefinition,
  type KeySchemaElement,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { CreateQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { SQSEvent } from "aws-lambda";
import { handler } from "./index.js";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const ACCOUNT_ID = "000000000000";

const DELTA_CURSOR_TABLE = "petroglyph-delta-tokens-int";
const FILE_RECORDS_TABLE = "petroglyph-file-records-int";
const SYNC_JOBS_TABLE = "petroglyph-sync-jobs-int";
const REFRESH_TOKENS_TABLE = "petroglyph-refresh-tokens-int";

/** The cursor the adapter wrote on this profile's row, keyed profileId. */
const ADAPTER_DELTA_LINK =
  "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=adapter-cursor";
/** The position the legacy walk reaches, read out of the page's deltaLink token. */
const LEGACY_WALK_TOKEN = "legacy-walk-token";

function makeSyncJobEvent(body: unknown): SQSEvent {
  return {
    Records: [
      {
        messageId: "message-legacy-run",
        receiptHandle: "receipt-legacy-run",
        body: JSON.stringify(body),
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1",
          SenderId: "sender-123",
          ApproximateFirstReceiveTimestamp: "1",
        },
        messageAttributes: {},
        md5OfBody: "md5",
        eventSource: "aws:sqs",
        eventSourceARN: `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:petroglyph-sync-jobs-int`,
        awsRegion: REGION,
      },
    ],
  };
}

/** One graph page as the legacy walk reads it: a single PDF and the position it reached. */
function mockGraphDeltaPage(): Response {
  return new Response(
    JSON.stringify({
      value: [
        {
          id: "pdf-legacy",
          name: "notes.pdf",
          file: { mimeType: "application/pdf" },
        },
      ],
      "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=${LEGACY_WALK_TOKEN}`,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function createTable(
  client: DynamoDBClient,
  options: { tableName: string; hashKey: string; rangeKey?: string },
): Promise<void> {
  const { rangeKey } = options;
  const keySchema: KeySchemaElement[] = [{ AttributeName: options.hashKey, KeyType: KeyType.HASH }];
  const attributeDefinitions: AttributeDefinition[] = [
    { AttributeName: options.hashKey, AttributeType: ScalarAttributeType.S },
  ];

  if (rangeKey !== undefined) {
    keySchema.push({ AttributeName: rangeKey, KeyType: KeyType.RANGE });
    attributeDefinitions.push({ AttributeName: rangeKey, AttributeType: ScalarAttributeType.S });
  }

  await client.send(
    new CreateTableCommand({
      TableName: options.tableName,
      KeySchema: keySchema,
      AttributeDefinitions: attributeDefinitions,
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
}

describe("legacy sync run against LocalStack DynamoDB", () => {
  let container: StartedTestContainer;
  let dynamo: DynamoDBDocumentClient;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb,sqs",
        AWS_ACCESS_KEY_ID: CREDENTIALS.accessKeyId,
        AWS_SECRET_ACCESS_KEY: CREDENTIALS.secretAccessKey,
        AWS_DEFAULT_REGION: REGION,
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .withStartupTimeout(120_000)
      .start();

    const endpoint = `http://localhost:${container.getMappedPort(4566)}`;
    // The handler builds its own clients from the environment, so these redirect
    // every one of them at LocalStack.
    vi.stubEnv("AWS_ENDPOINT_URL_DYNAMODB", endpoint);
    vi.stubEnv("AWS_ENDPOINT_URL_SQS", endpoint);
    vi.stubEnv("AWS_ACCESS_KEY_ID", CREDENTIALS.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", CREDENTIALS.secretAccessKey);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("DELTA_CURSOR_TABLE", DELTA_CURSOR_TABLE);
    vi.stubEnv("FILE_RECORDS_TABLE", FILE_RECORDS_TABLE);
    vi.stubEnv("SYNC_JOBS_TABLE", SYNC_JOBS_TABLE);
    vi.stubEnv("REFRESH_TOKENS_TABLE", REFRESH_TOKENS_TABLE);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client-id");

    const dynamoClient = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    const sqs = new SQSClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    dynamo = DynamoDBDocumentClient.from(dynamoClient);

    await createTable(dynamoClient, { tableName: DELTA_CURSOR_TABLE, hashKey: "profileId" });
    await createTable(dynamoClient, {
      tableName: FILE_RECORDS_TABLE,
      hashKey: "profileId",
      rangeKey: "fileId",
    });
    await createTable(dynamoClient, { tableName: SYNC_JOBS_TABLE, hashKey: "jobId" });
    await createTable(dynamoClient, { tableName: REFRESH_TOKENS_TABLE, hashKey: "tokenHash" });

    const queueName = "petroglyph-ingest-int";
    await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
    vi.stubEnv("INGEST_QUEUE_URL", `${endpoint}/${ACCOUNT_ID}/${queueName}`);

    vi.stubGlobal("fetch", () => Promise.resolve(mockGraphDeltaPage()));
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }, 30_000);

  it("a legacy run leaves the adapter's deltaLink in place on the shared row", async () => {
    const profileId = "profile-shared-cursor";

    await dynamo.send(
      new PutCommand({
        TableName: DELTA_CURSOR_TABLE,
        Item: {
          profileId,
          deltaLink: ADAPTER_DELTA_LINK,
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      }),
    );
    await dynamo.send(
      new PutCommand({
        TableName: REFRESH_TOKENS_TABLE,
        Item: {
          tokenHash: "user-legacy",
          accessToken: "onedrive-access-token",
          refreshToken: "onedrive-refresh-token",
          expirySeconds: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    );
    await dynamo.send(
      new PutCommand({
        TableName: SYNC_JOBS_TABLE,
        Item: { jobId: "job-legacy", status: "queued" },
      }),
    );

    const result = await handler(
      makeSyncJobEvent({
        jobId: "job-legacy",
        profileId,
        sourceFolderPath: "OnyxBoox",
        userId: "user-legacy",
      }),
    );

    expect(result.batchItemFailures).toEqual([]);

    const row = await dynamo.send(
      new GetCommand({ TableName: DELTA_CURSOR_TABLE, Key: { profileId } }),
    );

    expect(row.Item).toMatchObject({
      deltaLink: ADAPTER_DELTA_LINK,
      deltaToken: LEGACY_WALK_TOKEN,
    });
  }, 120_000);
});

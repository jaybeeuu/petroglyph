import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { LambdaEvent, handle } from "hono/aws-lambda";
import { putProfile, type SyncProfile } from "@petroglyph/core";
import { createStagedIndexStoreDdb } from "@petroglyph/staging-contracts";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const BUCKET = "petroglyph-staged-pdfs";
const FILE_RECORDS_TABLE = "staged-records-int";
const PROFILES_TABLE = "sync-profiles-int";
const JWT_PUBLIC_KEY_PATH = "/petroglyph/jwt/public-key";

const USER_ID = "user-1";
const ITEM_ID = "item-1";
const S3_KEY = "staging/v1/p1/notes/a.pdf";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n%%EOF");
const PROFILE: SyncProfile = {
  profileId: "p1",
  userId: USER_ID,
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

/** The API Gateway v2 shape Hono's aws-lambda adapter consumes. */
type ApiGatewayV2Event = Extract<LambdaEvent, { rawPath: string }>;

function apiGatewayEvent(
  method: string,
  rawPath: string,
  authorization?: string,
): ApiGatewayV2Event {
  return {
    version: "2.0",
    routeKey: `${method} ${rawPath}`,
    rawPath,
    rawQueryString: "",
    headers: {
      host: "test.execute-api.eu-west-2.amazonaws.com",
      ...(authorization === undefined ? {} : { authorization }),
    },
    requestContext: {
      accountId: "000000000000",
      apiId: "test",
      authentication: null,
      authorizer: {},
      domainName: "test.execute-api.eu-west-2.amazonaws.com",
      domainPrefix: "test",
      http: {
        method,
        path: rawPath,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "request-1",
      routeKey: `${method} ${rawPath}`,
      stage: "$default",
      time: "2026-09-01T00:00:00.000Z",
      timeEpoch: 1756684800000,
    },
    isBase64Encoded: false,
    body: null,
  };
}

describe("delivery app handler against LocalStack S3 + staged records", () => {
  let container: StartedTestContainer;
  let handler: ReturnType<typeof handle>;
  let authorization: string;
  let s3: S3Client;

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
    // The delivery app builds its own client from the environment; these
    // redirect every one of them at LocalStack before the app module loads.
    vi.stubEnv("AWS_ENDPOINT_URL_DYNAMODB", endpoint);
    vi.stubEnv("AWS_ENDPOINT_URL_S3", s3Endpoint);
    vi.stubEnv("AWS_ENDPOINT_URL_SSM", endpoint);
    vi.stubEnv("AWS_ACCESS_KEY_ID", CREDENTIALS.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", CREDENTIALS.secretAccessKey);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("FILE_RECORDS_TABLE", FILE_RECORDS_TABLE);
    vi.stubEnv("SYNC_PROFILES_TABLE", PROFILES_TABLE);
    vi.stubEnv("STAGED_PDFS_BUCKET", BUCKET);
    vi.stubEnv("JWT_PUBLIC_KEY_SSM_PATH", JWT_PUBLIC_KEY_PATH);

    const rawDynamo = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    await createTable(rawDynamo, FILE_RECORDS_TABLE, "profileId", "itemId");
    await createTable(rawDynamo, PROFILES_TABLE, "userId", "profileId");
    const dynamo = DynamoDBDocumentClient.from(rawDynamo);

    s3 = new S3Client({ region: REGION, endpoint, forcePathStyle: true, credentials: CREDENTIALS });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: S3_KEY,
        Body: PDF_BYTES,
        ContentType: "application/pdf",
      }),
    );

    const ssm = new SSMClient({ region: REGION, endpoint, credentials: CREDENTIALS });
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    await ssm.send(
      new PutParameterCommand({
        Name: JWT_PUBLIC_KEY_PATH,
        Value: await exportSPKI(publicKey),
        Type: "String",
        Overwrite: true,
      }),
    );
    authorization = `Bearer ${await new SignJWT({ username: "alice" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)}`;

    await putProfile(dynamo, PROFILES_TABLE, PROFILE);
    const index = createStagedIndexStoreDdb({ client: dynamo, tableName: FILE_RECORDS_TABLE });
    await index.upsert({
      profileId: "p1",
      itemId: ITEM_ID,
      s3Key: S3_KEY,
      relativePath: "notes",
      name: "a.pdf",
      source: "onedrive",
      mimeType: "application/pdf",
      status: "staged",
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    ({ handler } = await import("./index.js"));
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    vi.unstubAllEnvs();
  }, 30_000);

  it("GET /files returns the staged feed entry and its presigned URL downloads the real object", async () => {
    const response = await handler(apiGatewayEvent("GET", "/files", authorization));

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      files: { itemId: string; name: string; s3PresignedUrl: string }[];
    };
    expect(body.files).toHaveLength(1);
    const entry = body.files[0];
    expect(entry).toMatchObject({ itemId: ITEM_ID, name: "a.pdf" });

    const downloaded = await fetch(entry?.s3PresignedUrl ?? "");
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(PDF_BYTES);
  }, 60_000);

  it("GET /files/:itemId returns the owned entry and its presigned URL downloads the real object", async () => {
    const response = await handler(apiGatewayEvent("GET", `/files/${ITEM_ID}`, authorization));

    expect(response.statusCode).toBe(200);
    const entry = JSON.parse(response.body) as { itemId: string; s3PresignedUrl: string };
    expect(entry).toMatchObject({ itemId: ITEM_ID });

    const downloaded = await fetch(entry.s3PresignedUrl);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(PDF_BYTES);
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

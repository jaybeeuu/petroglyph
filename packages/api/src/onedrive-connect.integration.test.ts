import {
  CreateTableCommand,
  DynamoDBClient,
  type AttributeDefinition,
  type KeySchemaElement,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { tokenRecordSchema } from "@petroglyph/core";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { resetKeyCache } from "./jwt.js";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };

const TOKEN_VAULTS_TABLE = "petroglyph-token-vaults-int";
const REFRESH_TOKENS_TABLE = "petroglyph-refresh-tokens-int";
const SYNC_PROFILES_TABLE = "petroglyph-sync-profiles-int";
const USERS_TABLE = "petroglyph-users-int";

/** The body the stubbed Microsoft token endpoint answers with. */
interface MicrosoftTokenBody {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

describe("POST /onedrive/connect against LocalStack DynamoDB", () => {
  let container: StartedTestContainer;
  let dynamo: DynamoDBClient;
  let vault: DynamoDBDocumentClient;
  let privateKey: CryptoKey;
  const tokenEndpoints: Server[] = [];

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: REGION,
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .withStartupTimeout(120_000)
      .start();

    const endpoint = `http://localhost:${container.getMappedPort(4566)}`;
    dynamo = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });

    await createTable(dynamo, TOKEN_VAULTS_TABLE, "userId", "provider");
    await createTable(dynamo, REFRESH_TOKENS_TABLE, "tokenHash");
    await createTable(dynamo, SYNC_PROFILES_TABLE, "userId", "profileId");
    await createTable(dynamo, USERS_TABLE, "userId");
    vault = DynamoDBDocumentClient.from(dynamo);

    // The handler composes its own document client from the environment, so
    // these redirect it at LocalStack before the handler is first invoked.
    vi.stubEnv("AWS_ENDPOINT_URL_DYNAMODB", endpoint);
    vi.stubEnv("AWS_ACCESS_KEY_ID", CREDENTIALS.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", CREDENTIALS.secretAccessKey);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("TOKEN_VAULTS_TABLE", TOKEN_VAULTS_TABLE);
    vi.stubEnv("REFRESH_TOKENS_TABLE", REFRESH_TOKENS_TABLE);
    vi.stubEnv("SYNC_PROFILES_TABLE", SYNC_PROFILES_TABLE);
    vi.stubEnv("USERS_TABLE", USERS_TABLE);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "client-secret");
    vi.stubEnv("MICROSOFT_REDIRECT_URI", "https://api.petroglyph.test/onedrive/connect");
    // No Graph subscription: this seam runs from the token exchange to the
    // vault write, and a registered notification URL is what would reach Graph.
    vi.stubEnv("GRAPH_NOTIFICATION_URL", "");

    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    vi.stubEnv("JWT_PUBLIC_KEY", await exportSPKI(keyPair.publicKey));
    resetKeyCache();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    vi.unstubAllEnvs();
    resetKeyCache();
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tokenEndpoints.splice(0).map(closeServer));
  });

  it("writes the connection row into the token vault and the legacy refresh_tokens row", async () => {
    const tokens: MicrosoftTokenBody = {
      access_token: "ms-access-token",
      refresh_token: "ms-refresh-token",
      expires_in: 3600,
    };
    const tokenEndpoint = await startTokenEndpoint(tokens);
    redirectMicrosoftFetch(tokenEndpoint.origin);

    await vault.send(
      new PutCommand({
        TableName: REFRESH_TOKENS_TABLE,
        Item: {
          tokenHash: "state-9f1c",
          type: "onedrive_state",
          verifier: "code-verifier",
          ttl: Math.floor(Date.now() / 1000) + 600,
        },
      }),
    );

    const startedAt = Math.floor(Date.now() / 1000);
    const response = await createApp().request("/onedrive/connect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await makeToken("user-42")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: "ms-authorization-code", state: "state-9f1c" }),
    });
    const finishedAt = Math.floor(Date.now() / 1000);

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: "connected" });

    const vaultRow = await vault.send(
      new GetCommand({
        TableName: TOKEN_VAULTS_TABLE,
        Key: { userId: "user-42", provider: "onedrive" },
      }),
    );
    expect(vaultRow.Item).toMatchObject({ userId: "user-42", provider: "onedrive" });
    const record = tokenRecordSchema.parse(vaultRow.Item);
    expect(record).toMatchObject({
      accessToken: "ms-access-token",
      refreshToken: "ms-refresh-token",
      reconnectRequired: false,
    });
    expect(record.expirySeconds).toBeGreaterThanOrEqual(startedAt + 3600);
    expect(record.expirySeconds).toBeLessThanOrEqual(finishedAt + 3600);

    const legacyRow = await vault.send(
      new GetCommand({
        TableName: REFRESH_TOKENS_TABLE,
        Key: { tokenHash: "user-42" },
      }),
    );
    expect(legacyRow.Item).toMatchObject({
      accessToken: "ms-access-token",
      refreshToken: "ms-refresh-token",
    });
    expect(Number(legacyRow.Item?.["expirySeconds"])).toBeGreaterThanOrEqual(startedAt + 3600);
    expect(Number(legacyRow.Item?.["expirySeconds"])).toBeLessThanOrEqual(finishedAt + 3600);
  }, 60_000);

  async function makeToken(userId: string): Promise<string> {
    return new SignJWT({ username: "octocat" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(userId)
      .setIssuer("petroglyph-api")
      .setAudience("petroglyph-plugin")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  /** A local stand-in for `login.microsoftonline.com`; nothing leaves the machine. */
  async function startTokenEndpoint(
    tokens: MicrosoftTokenBody,
  ): Promise<{ server: Server; origin: string }> {
    const body = JSON.stringify(tokens);
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
        return;
      }
      // Any other request means the seam reached further than it should: answer
      // loudly instead of pretending the call succeeded.
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected request" }));
    });
    tokenEndpoints.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    return { server, origin: `http://127.0.0.1:${port}` };
  }
});

/** Points the Microsoft hosts at the local token endpoint; real HTTP still runs. */
function redirectMicrosoftFetch(origin: string): void {
  const realFetch = globalThis.fetch;
  const redirected: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.hostname === "login.microsoftonline.com" ? "/token" : url.pathname;
    return realFetch(new URL(path, origin), init);
  };
  vi.stubGlobal("fetch", redirected);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function createTable(
  client: DynamoDBClient,
  tableName: string,
  hashKey: string,
  rangeKey?: string,
): Promise<void> {
  const attributeDefinitions: AttributeDefinition[] = [
    { AttributeName: hashKey, AttributeType: "S" },
  ];
  const keySchema: KeySchemaElement[] = [{ AttributeName: hashKey, KeyType: "HASH" }];
  if (rangeKey !== undefined) {
    attributeDefinitions.push({ AttributeName: rangeKey, AttributeType: "S" });
    keySchema.push({ AttributeName: rangeKey, KeyType: "RANGE" });
  }

  return client
    .send(
      new CreateTableCommand({
        TableName: tableName,
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions,
        BillingMode: "PAY_PER_REQUEST",
      }),
    )
    .then(() => undefined);
}

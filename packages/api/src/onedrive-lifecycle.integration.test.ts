import {
  CreateTableCommand,
  DynamoDBClient,
  type AttributeDefinition,
  type KeySchemaElement,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  DynamoDBTokenStore,
  OAuthTokenResolver,
  tokenRecordSchema,
  type TokenRequestOutcome,
} from "@petroglyph/core";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "./app.js";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };

const TOKEN_VAULTS_TABLE = "petroglyph-token-vaults-lifecycle-int";
const USERS_TABLE = "petroglyph-users-lifecycle-int";

const USER_ID = "user-refresh";
const CONSENT_REFRESH_TOKEN = "consent-refresh-token";
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const tokenBodySchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

/**
 * A stand-in for the Microsoft token endpoint that rotates on every refresh and
 * answers `invalid_grant` for any token it has already rotated away — the real
 * behaviour that makes a second, stale copy of the grant fail.
 */
interface RotatingTokenEndpoint {
  server: Server;
  origin: string;
}

describe("OneDrive refresh through the API path and then the adapter", () => {
  let container: StartedTestContainer;
  let dynamo: DynamoDBClient;
  let vault: DynamoDBDocumentClient;
  let endpoint: RotatingTokenEndpoint;

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

    const localstack = `http://localhost:${container.getMappedPort(4566)}`;
    dynamo = new DynamoDBClient({ region: REGION, endpoint: localstack, credentials: CREDENTIALS });

    await createTable(dynamo, TOKEN_VAULTS_TABLE, "userId", "provider");
    await createTable(dynamo, USERS_TABLE, "userId");
    vault = DynamoDBDocumentClient.from(dynamo);

    vi.stubEnv("AWS_ENDPOINT_URL_DYNAMODB", localstack);
    vi.stubEnv("AWS_ACCESS_KEY_ID", CREDENTIALS.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", CREDENTIALS.secretAccessKey);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("TOKEN_VAULTS_TABLE", TOKEN_VAULTS_TABLE);
    vi.stubEnv("USERS_TABLE", USERS_TABLE);
    // No legacy refresh_tokens table exists in this workspace, so a write to it
    // fails loudly instead of passing silently.
    vi.stubEnv("REFRESH_TOKENS_TABLE", "petroglyph-refresh-tokens-lifecycle-int");
    vi.stubEnv("MICROSOFT_CLIENT_ID", "client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "client-secret");

    endpoint = await startRotatingTokenEndpoint(CONSENT_REFRESH_TOKEN);
    redirectMicrosoftFetch(endpoint.origin);
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeServer(endpoint.server);
    await container.stop();
  }, 30_000);

  it("refreshes through the API path and then through the adapter without invalid_grant", async () => {
    await seedConsentGrant();

    const lifecycleResponse = await createApp().request("/onedrive/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: [
          {
            lifecycleEvent: "reauthorizationRequired",
            clientState: USER_ID,
            subscriptionId: "sub-refresh",
          },
        ],
      }),
    });

    expect(lifecycleResponse.status).toBe(202);
    await vi.waitFor(async () => {
      expect(await storedRefreshToken()).toBe("api-rotated-refresh-token");
    });

    const adapterOutcome = await createAdapterResolver().resolveAccessToken(USER_ID, "onedrive", {
      force: true,
    });

    expect(adapterOutcome).toEqual({
      kind: "success",
      accessToken: "adapter-rotated-access-token",
    });
  }, 60_000);

  /** The row a completed `/onedrive/connect` leaves behind, already expired. */
  async function seedConsentGrant(): Promise<void> {
    await vault.send(
      new PutCommand({
        TableName: TOKEN_VAULTS_TABLE,
        Item: {
          userId: USER_ID,
          provider: "onedrive",
          accessToken: "consent-access-token",
          refreshToken: CONSENT_REFRESH_TOKEN,
          expirySeconds: 1_000,
          updatedAt: "2026-09-01T00:00:00.000Z",
          reconnectRequired: false,
        },
      }),
    );
  }

  async function storedRefreshToken(): Promise<string | undefined> {
    const row = await vault.send(
      new GetCommand({
        TableName: TOKEN_VAULTS_TABLE,
        Key: { userId: USER_ID, provider: "onedrive" },
      }),
    );
    return row.Item === undefined ? undefined : tokenRecordSchema.parse(row.Item).refreshToken;
  }

  /** The adapter's own composition: core's resolver over the connection vault. */
  function createAdapterResolver(): OAuthTokenResolver {
    return new OAuthTokenResolver({
      store: new DynamoDBTokenStore({
        client: DynamoDBDocumentClient.from(dynamo),
        tableName: TOKEN_VAULTS_TABLE,
      }),
      now: () => Math.floor(Date.now() / 1000),
      requestTokens: requestTokensFromStub,
    });
  }
});

/** The adapter's refresh call: Microsoft's answer decides success or a dead grant. */
async function requestTokensFromStub(refreshToken: string): Promise<TokenRequestOutcome> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    return { kind: "grant-invalid" };
  }

  const tokens = tokenBodySchema.parse(await response.json());
  return {
    kind: "success",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  };
}

async function startRotatingTokenEndpoint(
  currentRefreshToken: string,
): Promise<RotatingTokenEndpoint> {
  let validRefreshToken = currentRefreshToken;
  let rotation = 0;

  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/token") {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const presented = new URLSearchParams(body).get("refresh_token");
        if (presented !== validRefreshToken) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        rotation += 1;
        const rotated = {
          access_token: `${rotation === 1 ? "api" : "adapter"}-rotated-access-token`,
          refresh_token: `${rotation === 1 ? "api" : "adapter"}-rotated-refresh-token`,
          expires_in: 3600,
        };
        validRefreshToken = rotated.refresh_token;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(rotated));
      });
      return;
    }

    if (request.method === "POST" && request.url?.endsWith("/reauthorize")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected request" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

/** Points Graph and Microsoft hosts at the local endpoint; real HTTP still runs. */
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

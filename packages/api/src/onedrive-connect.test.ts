import { PutParameterCommand } from "@aws-sdk/client-ssm";
import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());
const mockSsmSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

vi.mock("./ssm.js", () => ({
  ssmClient: { send: mockSsmSend },
}));

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

// ─── Key pair (generated once for the suite) ────────────────────────────────

let privateKey: CryptoKey;
let publicKeyPem: string;

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  privateKey = keyPair.privateKey as CryptoKey;
  publicKeyPem = await exportSPKI(keyPair.publicKey);
});

// ─── Constants ────────────────────────────────────────────────────────────────

const USER_ID = "user-abc-123";
const USERNAME = "testuser";
const VALID_STATE = "550e8400-e29b-41d4-a716-446655440000";
const VALID_CODE = "ms-oauth-code-xyz";
const VALID_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const MS_ACCESS_TOKEN = "ms-access-token-abc";
const MS_REFRESH_TOKEN = "ms-refresh-token-def";
const MS_EXPIRES_IN = 3600;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStateItem(
  overrides: Partial<{ ttl: number; type: string; verifier: string }> = {},
): object {
  return {
    token: VALID_STATE,
    type: "onedrive_state",
    verifier: VALID_VERIFIER,
    ttl: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

function makeMsTokenResponse(): object {
  return {
    access_token: MS_ACCESS_TOKEN,
    refresh_token: MS_REFRESH_TOKEN,
    expires_in: MS_EXPIRES_IN,
  };
}

function setupDynamoMock(stateItem: object | undefined): void {
  mockDbSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      return Promise.resolve({ Item: stateItem });
    }
    if (cmd instanceof DeleteCommand) return Promise.resolve({});
    if (cmd instanceof UpdateCommand) return Promise.resolve({});
    return Promise.resolve({});
  });
}

function setupFetchMock(options: { msTokenOk?: boolean; graphOk?: boolean } = {}): void {
  const { msTokenOk = true, graphOk = true } = options;

  mockFetch.mockImplementation((url: string) => {
    if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
      if (!msTokenOk) {
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: () => Promise.resolve({ error: "invalid_grant" }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeMsTokenResponse()),
      } as Response);
    }
    if (url === "https://graph.microsoft.com/v1.0/subscriptions") {
      return Promise.resolve({
        ok: graphOk,
        status: graphOk ? 201 : 500,
        statusText: graphOk ? "Created" : "Internal Server Error",
        json: () => Promise.resolve({ id: "sub-123" }),
      } as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`));
  });
}

async function makeToken(): Promise<string> {
  return new SignJWT({ username: USERNAME })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(USER_ID)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

async function postConnect(body: {
  code?: string;
  state?: string;
}): Promise<Response> {
  const token = await makeToken();
  return app.request("/onedrive/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /onedrive/connect", () => {
  beforeEach(() => {
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-ms-client-id");
    vi.stubEnv("MICROSOFT_REDIRECT_URI", "obsidian://petroglyph/onedrive/callback");
    vi.stubEnv("GRAPH_NOTIFICATION_URL", "https://api.example.com/graph/notify");
    vi.stubEnv("SYNC_PROFILES_TABLE", "petroglyph-sync-profiles-test");
    vi.stubEnv("REFRESH_TOKENS_TABLE", "petroglyph-refresh_tokens-test");
    mockDbSend.mockClear();
    mockSsmSend.mockClear();
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetKeyCache();
  });

  // ── Behaviour 1: missing body fields → 400 ──────────────────────────────

  describe("body validation", () => {
    it("returns 400 when code is missing", async () => {
      setupDynamoMock(makeStateItem());
      setupFetchMock();

      const res = await postConnect({ state: VALID_STATE });

      expect(res.status).toBe(400);
    });

    it("returns 400 when state is missing", async () => {
      setupDynamoMock(makeStateItem());
      setupFetchMock();

      const res = await postConnect({ code: VALID_CODE });

      expect(res.status).toBe(400);
    });

    it("returns 400 when both fields are missing", async () => {
      setupDynamoMock(makeStateItem());
      setupFetchMock();

      const res = await postConnect({});

      expect(res.status).toBe(400);
    });
  });

  // ── Behaviour 2: invalid/expired state token → 401 ──────────────────────

  describe("state token validation", () => {
    it("returns 401 when state token is not found in DynamoDB", async () => {
      setupDynamoMock(undefined);
      setupFetchMock();

      const res = await postConnect({ code: VALID_CODE, state: VALID_STATE });

      expect(res.status).toBe(401);
    });

    it("returns 401 when state token has wrong type", async () => {
      setupDynamoMock(makeStateItem({ type: "oauth_state" }));
      setupFetchMock();

      const res = await postConnect({ code: VALID_CODE, state: VALID_STATE });

      expect(res.status).toBe(401);
    });

    it("returns 401 when state token TTL is in the past", async () => {
      setupDynamoMock(
        makeStateItem({ ttl: Math.floor(Date.now() / 1000) - 1 }),
      );
      setupFetchMock();

      const res = await postConnect({ code: VALID_CODE, state: VALID_STATE });

      expect(res.status).toBe(401);
    });
  });

  // ── Behaviour 3: state token deleted after use ───────────────────────────

  it("deletes the state token from DynamoDB after successful validation", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    await postConnect({ code: VALID_CODE, state: VALID_STATE });

    const deleteCalls = mockDbSend.mock.calls.filter(
      ([cmd]) => cmd instanceof DeleteCommand,
    );
    expect(deleteCalls).toHaveLength(1);
    const [deleteCmd] = deleteCalls[0] as [
      { input: { Key: { token: string } } },
    ];
    expect(deleteCmd.input.Key.token).toBe(VALID_STATE);
  });

  // ── Behaviour 4: Microsoft token exchange success ────────────────────────

  it("POSTs to Microsoft token endpoint with correct params", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    await postConnect({ code: VALID_CODE, state: VALID_STATE });

    const tokenCall = mockFetch.mock.calls.find(
      (args) =>
        args[0] === "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
    expect(tokenCall).toBeDefined();

    const [, options] = tokenCall as [string, RequestInit];
    expect(options.method).toBe("POST");

    const sentParams = new URLSearchParams(options.body as string);
    expect(sentParams.get("client_id")).toBe("test-ms-client-id");
    expect(sentParams.get("grant_type")).toBe("authorization_code");
    expect(sentParams.get("code")).toBe(VALID_CODE);
    expect(sentParams.get("redirect_uri")).toBe(
      "obsidian://petroglyph/onedrive/callback",
    );
    expect(sentParams.get("code_verifier")).toBe(VALID_VERIFIER);
    expect(sentParams.get("scope")).toBe("files.read offline_access");
  });

  // ── Behaviour 5: Microsoft token exchange non-ok → 502 ──────────────────

  it("returns 502 when Microsoft token exchange returns a non-ok response", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock({ msTokenOk: false });

    const res = await postConnect({ code: VALID_CODE, state: VALID_STATE });

    expect(res.status).toBe(502);
  });

  // ── Behaviour 6: tokens stored in SSM ───────────────────────────────────

  it("stores access token, refresh token, and expiry in SSM as SecureString", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    const before = Date.now();
    await postConnect({ code: VALID_CODE, state: VALID_STATE });
    const after = Date.now();

    const ssmCalls = mockSsmSend.mock.calls.filter(
      ([cmd]) => cmd instanceof PutParameterCommand,
    );
    expect(ssmCalls).toHaveLength(3);

    const byName = Object.fromEntries(
      ssmCalls.map(([cmd]) => {
        const { Name, Value, Type, Overwrite } = (
          cmd as {
            input: {
              Name: string;
              Value: string;
              Type: string;
              Overwrite: boolean;
            };
          }
        ).input;
        return [Name, { Value, Type, Overwrite }];
      }),
    );

    expect(byName["/petroglyph/onedrive/access-token"]?.Value).toBe(MS_ACCESS_TOKEN);
    expect(byName["/petroglyph/onedrive/access-token"]?.Type).toBe("SecureString");
    expect(byName["/petroglyph/onedrive/access-token"]?.Overwrite).toBe(true);

    expect(byName["/petroglyph/onedrive/refresh-token"]?.Value).toBe(MS_REFRESH_TOKEN);
    expect(byName["/petroglyph/onedrive/refresh-token"]?.Type).toBe("SecureString");
    expect(byName["/petroglyph/onedrive/refresh-token"]?.Overwrite).toBe(true);

    const expiryValue = byName["/petroglyph/onedrive/token-expiry"]?.Value;
    expect(expiryValue).toBeDefined();
    const expiryMs = new Date(expiryValue as string).getTime();
    expect(expiryMs).toBeGreaterThanOrEqual(before + MS_EXPIRES_IN * 1000);
    expect(expiryMs).toBeLessThanOrEqual(after + MS_EXPIRES_IN * 1000);
    expect(byName["/petroglyph/onedrive/token-expiry"]?.Type).toBe("SecureString");
    expect(byName["/petroglyph/onedrive/token-expiry"]?.Overwrite).toBe(true);
  });

  // ── Behaviour 7: Graph subscription registered ───────────────────────────

  it("POSTs to Graph subscriptions endpoint with correct body", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    const before = Date.now();
    await postConnect({ code: VALID_CODE, state: VALID_STATE });
    const after = Date.now();

    const graphCall = mockFetch.mock.calls.find(
      (args) => args[0] === "https://graph.microsoft.com/v1.0/subscriptions",
    );
    expect(graphCall).toBeDefined();

    const [, options] = graphCall as [string, RequestInit];
    expect(options.method).toBe("POST");

    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${MS_ACCESS_TOKEN}`);

    const sentBody = JSON.parse(options.body as string) as {
      changeType: string;
      notificationUrl: string;
      resource: string;
      expirationDateTime: string;
      clientState: string;
    };
    expect(sentBody.changeType).toBe("updated");
    expect(sentBody.notificationUrl).toBe("https://api.example.com/graph/notify");
    expect(sentBody.resource).toBe("/me/drive/root/children");
    expect(sentBody.clientState).toBe(USER_ID);

    const expiryMs = new Date(sentBody.expirationDateTime).getTime();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    expect(expiryMs).toBeGreaterThanOrEqual(before + threeDaysMs);
    expect(expiryMs).toBeLessThanOrEqual(after + threeDaysMs);
  });

  it("returns 200 even when Graph subscription registration fails", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock({ graphOk: false });

    const res = await postConnect({ code: VALID_CODE, state: VALID_STATE });

    expect(res.status).toBe(200);
  });

  it("skips Graph subscription when GRAPH_NOTIFICATION_URL is not set", async () => {
    vi.stubEnv("GRAPH_NOTIFICATION_URL", "");
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    const res = await postConnect({ code: VALID_CODE, state: VALID_STATE });

    expect(res.status).toBe(200);
    const graphCall = mockFetch.mock.calls.find(
      (args) => args[0] === "https://graph.microsoft.com/v1.0/subscriptions",
    );
    expect(graphCall).toBeUndefined();
  });

  // ── Behaviour 8: SyncProfile upserted in DynamoDB ───────────────────────

  it("upserts SyncProfile in DynamoDB with userId, profileId=default, oneDriveConnected=true", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    await postConnect({ code: VALID_CODE, state: VALID_STATE });

    const updateCalls = mockDbSend.mock.calls.filter(
      ([cmd]) => cmd instanceof UpdateCommand,
    );
    expect(updateCalls).toHaveLength(1);
    const [updateCmd] = updateCalls[0] as [
      {
        input: {
          TableName: string;
          Key: { userId: string; profileId: string };
          ExpressionAttributeValues: Record<string, unknown>;
        };
      },
    ];
    expect(updateCmd.input.TableName).toBe("petroglyph-sync-profiles-test");
    expect(updateCmd.input.Key.userId).toBe(USER_ID);
    expect(updateCmd.input.Key.profileId).toBe("default");
    expect(updateCmd.input.ExpressionAttributeValues[":true"]).toBe(true);
    expect(typeof updateCmd.input.ExpressionAttributeValues[":now"]).toBe("string");
  });

  // ── Behaviour 9: returns 200 { status: 'connected' } ────────────────────

  it("returns 200 with { status: 'connected' } on success", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    const res = await postConnect({ code: VALID_CODE, state: VALID_STATE });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("connected");
  });

  // ── Auth guard ───────────────────────────────────────────────────────────

  it("returns 401 when no JWT is provided", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    const res = await app.request("/onedrive/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: VALID_CODE, state: VALID_STATE }),
    });

    expect(res.status).toBe(401);
  });
});

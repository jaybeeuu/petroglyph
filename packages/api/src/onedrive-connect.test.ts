import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
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
const MS_DRIVE_ID = "drive-123";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStateItem(
  overrides: Partial<{ ttl: number; type: string; verifier: string }> = {},
): object {
  return {
    tokenHash: VALID_STATE,
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

function setupFetchMock(
  options: { msTokenOk?: boolean; graphOk?: boolean; graphDriveOk?: boolean } = {},
): void {
  const { msTokenOk = true, graphOk = true, graphDriveOk = true } = options;

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
    if (url === "https://graph.microsoft.com/v1.0/me/drive") {
      if (!graphDriveOk) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: () => Promise.resolve({}),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: MS_DRIVE_ID }),
      } as Response);
    }
    if (url === "https://graph.microsoft.com/v1.0/subscriptions") {
      return Promise.resolve({
        ok: graphOk,
        status: graphOk ? 201 : 500,
        statusText: graphOk ? "Created" : "Internal Server Error",
        json: () => Promise.resolve({ id: "sub-123" }),
        text: () => Promise.resolve('{"error":"Invalid request"}'),
      } as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
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

async function postConnect(body: { code?: string; state?: string }): Promise<Response> {
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-ms-client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-ms-client-secret");
    vi.stubEnv("MICROSOFT_REDIRECT_URI", "obsidian://petroglyph/onedrive/callback");
    vi.stubEnv("GRAPH_NOTIFICATION_URL", "https://api.example.com/graph/notify");
    vi.stubEnv("GRAPH_LIFECYCLE_URL", "https://api.example.com/graph/lifecycle");
    vi.stubEnv("SYNC_PROFILES_TABLE", "petroglyph-sync-profiles-test");
    vi.stubEnv("REFRESH_TOKENS_TABLE", "petroglyph-refresh_tokens-test");
    vi.stubEnv("USERS_TABLE", "petroglyph-users-test");
    mockDbSend.mockClear();
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
      setupDynamoMock(makeStateItem({ ttl: Math.floor(Date.now() / 1000) - 1 }));
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

    const deleteCalls = mockDbSend.mock.calls.filter(([cmd]) => cmd instanceof DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    const [deleteCmd] = deleteCalls[0] as [{ input: { Key: { tokenHash: string } } }];
    expect(deleteCmd.input.Key.tokenHash).toBe(VALID_STATE);
  });

  // ── Behaviour 4: Microsoft token exchange success ────────────────────────

  it("POSTs to Microsoft token endpoint with correct params including client_secret", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    await postConnect({ code: VALID_CODE, state: VALID_STATE });

    const tokenCall = mockFetch.mock.calls.find(
      (args) => args[0] === "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
    expect(tokenCall).toBeDefined();

    const [, options] = tokenCall as [string, RequestInit];
    expect(options.method).toBe("POST");

    const sentParams = new URLSearchParams(options.body as string);
    expect(sentParams.get("client_id")).toBe("test-ms-client-id");
    expect(sentParams.get("client_secret")).toBe("test-ms-client-secret");
    expect(sentParams.get("grant_type")).toBe("authorization_code");
    expect(sentParams.get("code")).toBe(VALID_CODE);
    expect(sentParams.get("redirect_uri")).toBe("obsidian://petroglyph/onedrive/callback");
    expect(sentParams.get("code_verifier")).toBe(VALID_VERIFIER);
    expect(sentParams.get("scope")).toBe("files.readwrite offline_access");
  });

  it("returns 500 when MICROSOFT_CLIENT_SECRET is not configured", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();
    delete process.env["MICROSOFT_CLIENT_SECRET"];

    const res = await postConnect({ code: VALID_CODE, state: VALID_STATE });

    expect(res.status).toBe(500);
  });

  it("returns 502 when Microsoft rejects token exchange due to wrong client_secret", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock({ msTokenOk: false });

    const res = await postConnect({ code: VALID_CODE, state: VALID_STATE });

    expect(res.status).toBe(502);
  });

  // ── Behaviour 5: Microsoft token exchange non-ok → 502 ──────────────────

  it("returns 502 when Microsoft token exchange returns a non-ok response", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock({ msTokenOk: false });

    const res = await postConnect({ code: VALID_CODE, state: VALID_STATE });

    expect(res.status).toBe(502);
  });

  // ── Behaviour 6: tokens stored in SSM ───────────────────────────────────

  it("stores access token, refresh token, and expiry in DynamoDB refresh_tokens table", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    const before = Math.floor(Date.now() / 1000);
    await postConnect({ code: VALID_CODE, state: VALID_STATE });
    const after = Math.floor(Date.now() / 1000);

    const updateCalls = mockDbSend.mock.calls.filter(([cmd]) => cmd instanceof UpdateCommand);
    const [tokenCmd] = updateCalls[0] as [
      {
        input: {
          TableName: string;
          Key: { tokenHash: string };
          UpdateExpression: string;
          ExpressionAttributeValues: {
            ":accessToken": string;
            ":refreshToken": string;
            ":expirySeconds": number;
            ":now": string;
          };
        };
      },
    ];

    expect(tokenCmd.input.TableName).toBe("petroglyph-refresh_tokens-test");
    expect(tokenCmd.input.Key.tokenHash).toBe(USER_ID);
    expect(tokenCmd.input.ExpressionAttributeValues[":accessToken"]).toBe(MS_ACCESS_TOKEN);
    expect(tokenCmd.input.ExpressionAttributeValues[":refreshToken"]).toBe(MS_REFRESH_TOKEN);

    const expirySeconds = tokenCmd.input.ExpressionAttributeValues[":expirySeconds"];
    expect(expirySeconds).toBeGreaterThanOrEqual(before + MS_EXPIRES_IN);
    expect(expirySeconds).toBeLessThanOrEqual(after + MS_EXPIRES_IN);
    expect(typeof tokenCmd.input.ExpressionAttributeValues[":now"]).toBe("string");
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

    const headers = options.headers as { [key: string]: string };
    expect(headers["Authorization"]).toBe(`Bearer ${MS_ACCESS_TOKEN}`);

    const sentBody = JSON.parse(options.body as string) as {
      changeType: string;
      notificationUrl: string;
      lifecycleNotificationUrl?: string;
      resource: string;
      expirationDateTime: string;
      clientState: string;
    };
    expect(sentBody.changeType).toBe("updated");
    expect(sentBody.notificationUrl).toBe("https://api.example.com/graph/notify");
    expect(sentBody.lifecycleNotificationUrl).toBe("https://api.example.com/graph/lifecycle");
    expect(sentBody.resource).toBe(`/drives/${MS_DRIVE_ID}/root`);
    expect(sentBody.clientState).toBe(USER_ID);

    const expiryMs = new Date(sentBody.expirationDateTime).getTime();
    const maxGraphSubscriptionMs = 4230 * 60 * 1000;
    expect(expiryMs).toBeGreaterThanOrEqual(before + maxGraphSubscriptionMs - 5000);
    expect(expiryMs).toBeLessThanOrEqual(after + maxGraphSubscriptionMs);
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

    const updateCalls = mockDbSend.mock.calls.filter(([cmd]) => cmd instanceof UpdateCommand);
    expect(updateCalls).toHaveLength(3); // tokens update + sync profile update + user status update

    const [syncProfileCmd] = updateCalls[1] as [
      {
        input: {
          TableName: string;
          Key: { userId: string; profileId: string };
          ExpressionAttributeValues: { [key: string]: unknown };
        };
      },
    ];
    expect(syncProfileCmd.input.TableName).toBe("petroglyph-sync-profiles-test");
    expect(syncProfileCmd.input.Key.userId).toBe(USER_ID);
    expect(syncProfileCmd.input.Key.profileId).toBe("default");
    expect(syncProfileCmd.input.ExpressionAttributeValues[":true"]).toBe(true);
    expect(typeof syncProfileCmd.input.ExpressionAttributeValues[":now"]).toBe("string");

    const [userStatusCmd] = updateCalls[2] as [
      {
        input: {
          TableName: string;
          Key: { userId: string };
          ExpressionAttributeValues: { [key: string]: unknown };
        };
      },
    ];
    expect(userStatusCmd.input.TableName).toBe("petroglyph-users-test");
    expect(userStatusCmd.input.Key).toEqual({ userId: USER_ID });
    expect(userStatusCmd.input.ExpressionAttributeValues[":connected"]).toBe("connected");
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

// ───────────────────────────────────────────────────────────────────────────────
// GET /onedrive/connect — OAuth callback bridge
// ───────────────────────────────────────────────────────────────────────────────

describe("GET /onedrive/connect", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-ms-client-id");
    vi.stubEnv("MICROSOFT_REDIRECT_URI", "obsidian://petroglyph/onedrive/callback");
    vi.stubEnv("GRAPH_NOTIFICATION_URL", "https://api.example.com/graph/notify");
    vi.stubEnv("SYNC_PROFILES_TABLE", "petroglyph-sync-profiles-test");
    vi.stubEnv("REFRESH_TOKENS_TABLE", "petroglyph-refresh_tokens-test");
    mockDbSend.mockClear();
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetKeyCache();
  });

  // ── Browser callback happy path ───────────────────────────────────────────

  it("accepts code and state as query params and redirects to obsidian:// deep link", async () => {
    const res = await app.request(`/onedrive/connect?code=${VALID_CODE}&state=${VALID_STATE}`, {
      method: "GET",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("Location");
    expect(location).toBe(
      `obsidian://petroglyph/oauth/callback?code=${VALID_CODE}&state=${VALID_STATE}`,
    );
  });

  it("redirects OAuth errors to obsidian:// callback with error and state", async () => {
    const res = await app.request(
      `/onedrive/connect?error=server_error&state=${VALID_STATE}&error_description=Something+went+wrong`,
      {
        method: "GET",
      },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location");
    expect(location).toContain("obsidian://petroglyph/oauth/callback?");
    expect(location).toContain("error=server_error");
    expect(location).toContain(`state=${VALID_STATE}`);
    expect(location).toContain("error_description=Something+went+wrong");
  });

  // ── Missing query params ──────────────────────────────────────────────────

  it("returns 400 when code query param is missing", async () => {
    const res = await app.request(`/onedrive/connect?state=${VALID_STATE}`, {
      method: "GET",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/code/i);
  });

  it("returns 400 when state query param is missing", async () => {
    const res = await app.request(`/onedrive/connect?code=${VALID_CODE}`, {
      method: "GET",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/state/i);
  });

  it("returns 400 when both code and state query params are missing", async () => {
    const res = await app.request("/onedrive/connect", {
      method: "GET",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/(code|state)/i);
  });

  it("returns 400 when code query param is empty string", async () => {
    const res = await app.request(`/onedrive/connect?code=&state=${VALID_STATE}`, {
      method: "GET",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/code/i);
  });

  it("returns 400 when state query param is empty string", async () => {
    const res = await app.request(`/onedrive/connect?code=${VALID_CODE}&state=`, {
      method: "GET",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/state/i);
  });

  // ── Auth exemption ────────────────────────────────────────────────────────

  it("does not require Authorization header (is auth-exempt)", async () => {
    const res = await app.request(`/onedrive/connect?code=${VALID_CODE}&state=${VALID_STATE}`, {
      method: "GET",
    });

    expect(res.status).toBe(302);
  });

  it("ignores Authorization header even if provided", async () => {
    const res = await app.request(`/onedrive/connect?code=${VALID_CODE}&state=${VALID_STATE}`, {
      method: "GET",
      headers: { Authorization: "Bearer invalid-token" },
    });

    expect(res.status).toBe(302);
  });

  // ── Verify POST still works ───────────────────────────────────────────────

  it("does not interfere with POST /onedrive/connect", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-ms-client-secret");

    const token = await makeToken();
    const res = await app.request("/onedrive/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code: VALID_CODE, state: VALID_STATE }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("connected");
  });

  // ── Harness callback URI ──────────────────────────────────────────────────

  describe("when state encodes a harnessCallbackUri", () => {
    const HARNESS_URI = "http://127.0.0.1:8787/onedrive-callback";
    const HARNESS_STATE = `${VALID_STATE}|${Buffer.from(HARNESS_URI).toString("base64url")}`;

    it("redirects to harnessCallbackUri instead of obsidian://", async () => {
      const res = await app.request(
        `/onedrive/connect?code=${VALID_CODE}&state=${encodeURIComponent(HARNESS_STATE)}`,
        { method: "GET" },
      );

      expect(res.status).toBe(302);
      const location = res.headers.get("Location");
      expect(location).toContain(HARNESS_URI);
      expect(location).toContain(`code=${VALID_CODE}`);
      expect(location).not.toContain("obsidian://");
    });

    it("redirects OAuth errors to harnessCallbackUri instead of obsidian://", async () => {
      const res = await app.request(
        `/onedrive/connect?error=access_denied&state=${encodeURIComponent(HARNESS_STATE)}`,
        { method: "GET" },
      );

      expect(res.status).toBe(302);
      const location = res.headers.get("Location");
      expect(location).toContain(HARNESS_URI);
      expect(location).toContain("error=access_denied");
      expect(location).not.toContain("obsidian://");
    });
  });
});

describe("POST /onedrive/connect with harness state", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-ms-client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-ms-client-secret");
    vi.stubEnv("MICROSOFT_REDIRECT_URI", "obsidian://petroglyph/onedrive/callback");
    vi.stubEnv("GRAPH_NOTIFICATION_URL", "https://api.example.com/graph/notify");
    vi.stubEnv("SYNC_PROFILES_TABLE", "petroglyph-sync-profiles-test");
    vi.stubEnv("REFRESH_TOKENS_TABLE", "petroglyph-refresh_tokens-test");
    mockDbSend.mockClear();
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetKeyCache();
  });

  it("strips the harness suffix from state before DynamoDB lookup and returns connected", async () => {
    const HARNESS_URI = "http://127.0.0.1:8787/onedrive-callback";
    const fullState = `${VALID_STATE}|${Buffer.from(HARNESS_URI).toString("base64url")}`;

    setupDynamoMock(makeStateItem());
    setupFetchMock();

    const token = await makeToken();
    const res = await app.request("/onedrive/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code: VALID_CODE, state: fullState }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("connected");

    const getCall = mockDbSend.mock.calls.find(([cmd]) => cmd instanceof GetCommand) as
      | [{ input: { Key: { tokenHash: string } } }]
      | undefined;
    expect(getCall).toBeDefined();
    expect(getCall?.[0].input.Key.tokenHash).toBe(VALID_STATE);
  });
});

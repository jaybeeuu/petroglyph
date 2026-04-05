import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  exportPKCS8,
  generateKeyPair,
  importSPKI,
  jwtVerify,
  exportSPKI,
} from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mockSend = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockSend },
}));

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

import { app } from "./app.js";

// ─── Key pair (generated once for the suite) ────────────────────────────────

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  privateKeyPem = await exportPKCS8(privateKey);
  publicKeyPem = await exportSPKI(publicKey);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_STATE = "550e8400-e29b-41d4-a716-446655440000";
const GITHUB_CODE = "github-oauth-code-abc";
const GITHUB_USER_ID = 12345;
const GITHUB_USERNAME = "testuser";
const GITHUB_ACCESS_TOKEN = "gha_test_token_xyz";

function makeStateItem(overrides: Partial<{ ttl: number; type: string }> = {}) {
  return {
    token: VALID_STATE,
    type: "oauth_state",
    ttl: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

function makeGitHubTokenResponse() {
  return { access_token: GITHUB_ACCESS_TOKEN };
}

function makeGitHubUserResponse() {
  return { id: GITHUB_USER_ID, login: GITHUB_USERNAME };
}

function setupDynamoMock(
  stateItem: object | undefined,
  options: { rejectGet?: boolean } = {},
) {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      if (options.rejectGet) return Promise.reject(new Error("DynamoDB error"));
      return Promise.resolve({ Item: stateItem });
    }
    if (cmd instanceof DeleteCommand) return Promise.resolve({});
    if (cmd instanceof UpdateCommand) return Promise.resolve({});
    if (cmd instanceof PutCommand) return Promise.resolve({});
    return Promise.resolve({});
  });
}

function setupFetchMock() {
  mockFetch.mockImplementation((url: string) => {
    if (url === "https://github.com/login/oauth/access_token") {
      return Promise.resolve({
        json: () => Promise.resolve(makeGitHubTokenResponse()),
        ok: true,
      } as Response);
    }
    if (url === "https://api.github.com/user") {
      return Promise.resolve({
        json: () => Promise.resolve(makeGitHubUserResponse()),
        ok: true,
      } as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`));
  });
}

async function postCallback(body: {
  code?: string;
  state?: string;
}): Promise<Response> {
  return app.request("/auth/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /auth/callback", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("JWT_PRIVATE_KEY", privateKeyPem);
    mockSend.mockClear();
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── Behaviour 1: missing / invalid state → 401 ─────────────────────────

  describe("state validation", () => {
    it("returns 401 when state is not found in DynamoDB", async () => {
      setupDynamoMock(undefined);
      setupFetchMock();

      const res = await postCallback({ code: GITHUB_CODE, state: VALID_STATE });

      expect(res.status).toBe(401);
    });

    // ── Behaviour 2: expired state → 401 ─────────────────────────────────

    it("returns 401 when state TTL is in the past", async () => {
      setupDynamoMock(
        makeStateItem({ ttl: Math.floor(Date.now() / 1000) - 1 }),
      );
      setupFetchMock();

      const res = await postCallback({ code: GITHUB_CODE, state: VALID_STATE });

      expect(res.status).toBe(401);
    });

    it("returns 401 when state has wrong type", async () => {
      setupDynamoMock(makeStateItem({ type: "refresh_token" }));
      setupFetchMock();

      const res = await postCallback({ code: GITHUB_CODE, state: VALID_STATE });

      expect(res.status).toBe(401);
    });
  });

  // ── Behaviour 3: valid state deleted after use ────────────────────────────

  it("deletes the state token from DynamoDB after successful lookup", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    await postCallback({ code: GITHUB_CODE, state: VALID_STATE });

    const deleteCalls = mockSend.mock.calls.filter(
      ([cmd]) => cmd instanceof DeleteCommand,
    );
    expect(deleteCalls).toHaveLength(1);
    const [deleteCmd] = deleteCalls[0] as [{ input: { Key: { token: string } } }];
    expect(deleteCmd.input.Key.token).toBe(VALID_STATE);
  });

  // ── Behaviour 4: GitHub code exchange ────────────────────────────────────

  it("exchanges the code with GitHub using POST to token endpoint", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    await postCallback({ code: GITHUB_CODE, state: VALID_STATE });

    const exchangeCall = mockFetch.mock.calls.find(
      (args) => args[0] === "https://github.com/login/oauth/access_token",
    );
    expect(exchangeCall).toBeDefined();

    const [, options] = exchangeCall as [string, RequestInit];
    expect(options.method).toBe("POST");
    const sentBody = JSON.parse(options.body as string) as {
      client_id: string;
      client_secret: string;
      code: string;
    };
    expect(sentBody.client_id).toBe("test-client-id");
    expect(sentBody.client_secret).toBe("test-client-secret");
    expect(sentBody.code).toBe(GITHUB_CODE);
  });

  // ── Behaviour 5: GitHub user fetch ───────────────────────────────────────

  it("fetches the GitHub user with the access token", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    await postCallback({ code: GITHUB_CODE, state: VALID_STATE });

    const userCall = mockFetch.mock.calls.find(
      (args) => args[0] === "https://api.github.com/user",
    );
    expect(userCall).toBeDefined();

    const [, options] = userCall as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${GITHUB_ACCESS_TOKEN}`);
  });

  // ── Behaviour 6: user upserted in DynamoDB ───────────────────────────────

  it("upserts the user in the users table", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    vi.stubEnv("USERS_TABLE", "petroglyph-users-test");
    await postCallback({ code: GITHUB_CODE, state: VALID_STATE });

    const updateCalls = mockSend.mock.calls.filter(
      ([cmd]) => cmd instanceof UpdateCommand,
    );
    expect(updateCalls).toHaveLength(1);
    const [updateCmd] = updateCalls[0] as [
      {
        input: {
          TableName: string;
          Key: { userId: string };
          ExpressionAttributeValues: Record<string, string>;
        };
      },
    ];
    expect(updateCmd.input.TableName).toBe("petroglyph-users-test");
    expect(updateCmd.input.Key.userId).toBe(String(GITHUB_USER_ID));
    expect(updateCmd.input.ExpressionAttributeValues[":username"]).toBe(
      GITHUB_USERNAME,
    );
  });

  // ── Behaviour 7: JWT issued RS256 with 1hr expiry ────────────────────────

  it("issues an RS256 JWT with sub=userId and username claim, expiring in ~1 hour", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    const before = Math.floor(Date.now() / 1000);
    const res = await postCallback({ code: GITHUB_CODE, state: VALID_STATE });
    const after = Math.floor(Date.now() / 1000);

    const body = (await res.json()) as { jwt: string };
    const publicKey = await importSPKI(publicKeyPem, "RS256");
    const { payload, protectedHeader } = await jwtVerify(body.jwt, publicKey);

    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.sub).toBe(String(GITHUB_USER_ID));
    expect(payload["username"]).toBe(GITHUB_USERNAME);
    expect(payload.exp).toBeGreaterThanOrEqual(before + 3600);
    expect(payload.exp).toBeLessThanOrEqual(after + 3600);
  });

  // ── Behaviour 8: refresh token stored in DynamoDB ────────────────────────

  it("stores a hashed refresh token in DynamoDB with 90-day TTL", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    vi.stubEnv("REFRESH_TOKENS_TABLE", "petroglyph-refresh_tokens-test");
    const before = Math.floor(Date.now() / 1000);
    const res = await postCallback({ code: GITHUB_CODE, state: VALID_STATE });
    const after = Math.floor(Date.now() / 1000);

    const body = (await res.json()) as { refreshToken: string };

    const putCalls = mockSend.mock.calls.filter(
      ([cmd]) => cmd instanceof PutCommand,
    );
    expect(putCalls).toHaveLength(1);
    const [putCmd] = putCalls[0] as [
      {
        input: {
          TableName: string;
          Item: { token: string; type: string; userId: string; ttl: number };
        };
      },
    ];

    expect(putCmd.input.TableName).toBe("petroglyph-refresh_tokens-test");
    expect(putCmd.input.Item.type).toBe("refresh_token");
    expect(putCmd.input.Item.userId).toBe(String(GITHUB_USER_ID));

    // stored token should be the SHA-256 hash of the returned UUID, not the UUID itself
    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256")
      .update(body.refreshToken)
      .digest("hex");
    expect(putCmd.input.Item.token).toBe(expectedHash);

    const ninetyDays = 90 * 24 * 60 * 60;
    expect(putCmd.input.Item.ttl).toBeGreaterThanOrEqual(before + ninetyDays);
    expect(putCmd.input.Item.ttl).toBeLessThanOrEqual(after + ninetyDays);
  });

  // ── Behaviour 9: 200 { jwt, refreshToken, username } ─────────────────────

  it("returns 200 with jwt, refreshToken, and username", async () => {
    setupDynamoMock(makeStateItem());
    setupFetchMock();

    const res = await postCallback({ code: GITHUB_CODE, state: VALID_STATE });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jwt: string;
      refreshToken: string;
      username: string;
    };
    expect(typeof body.jwt).toBe("string");
    expect(body.jwt.length).toBeGreaterThan(0);
    expect(typeof body.refreshToken).toBe("string");
    expect(body.refreshToken.length).toBeGreaterThan(0);
    expect(body.username).toBe(GITHUB_USERNAME);
  });
});

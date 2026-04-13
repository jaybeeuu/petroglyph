import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

const mockSend = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockSend },
}));

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

// ─── Constants ────────────────────────────────────────────────────────────────

const USER_ID = "12345";
const USERNAME = "testuser";
const REFRESH_TOKENS_TABLE = "petroglyph-refresh_tokens-test";
const USERS_TABLE = "petroglyph-users-test";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTokenItem(
  overrides: Partial<{ ttl: number; type: string; superseded: boolean }> = {},
): object {
  return {
    token: "somehash",
    type: "refresh_token",
    userId: USER_ID,
    ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
    superseded: false,
    ...overrides,
  };
}

function makeUserItem(): object {
  return { userId: USER_ID, username: USERNAME };
}

function makeConditionalCheckError(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
  });
}

function setupDynamoMock(
  options: {
    tokenItem?: object | undefined;
    userItem?: object;
    scanPages?: object[][];
    updateShouldFail?: boolean;
  } = {},
): void {
  const {
    tokenItem,
    userItem = makeUserItem(),
    scanPages = [[]],
    updateShouldFail = false,
  } = options;

  let scanPageIndex = 0;

  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      const tableName = (cmd as { input: { TableName: string } }).input.TableName;
      if (tableName === REFRESH_TOKENS_TABLE) {
        return Promise.resolve({ Item: tokenItem });
      }
      if (tableName === USERS_TABLE) {
        return Promise.resolve({ Item: userItem });
      }
      return Promise.resolve({ Item: undefined });
    }
    if (cmd instanceof UpdateCommand) {
      if (updateShouldFail) {
        return Promise.reject(makeConditionalCheckError());
      }
      return Promise.resolve({});
    }
    if (cmd instanceof PutCommand) return Promise.resolve({});
    if (cmd instanceof ScanCommand) {
      const page = scanPages[scanPageIndex] ?? [];
      const nextPage = scanPages[scanPageIndex + 1];
      scanPageIndex++;
      return Promise.resolve({
        Items: page,
        LastEvaluatedKey: nextPage !== undefined ? { token: `cursor-${scanPageIndex}` } : undefined,
      });
    }
    if (cmd instanceof DeleteCommand) return Promise.resolve({});
    return Promise.resolve({});
  });
}

async function postRefresh(body: { refreshToken?: string }): Promise<Response> {
  return app.request("/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /auth/refresh", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("JWT_PRIVATE_KEY", privateKeyPem);
    vi.stubEnv("REFRESH_TOKENS_TABLE", REFRESH_TOKENS_TABLE);
    vi.stubEnv("USERS_TABLE", USERS_TABLE);
    mockSend.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // ── Behaviour: missing/invalid refreshToken body → 400 ───────────────────

  it("returns 400 with 'Missing refreshToken' when refreshToken is absent", async () => {
    setupDynamoMock();

    const res = await postRefresh({});

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing refreshToken");
  });

  // ── Behaviour: token not found → 401 ─────────────────────────────────────

  it("returns 401 with 'Invalid refresh token' when token is not found", async () => {
    setupDynamoMock({ tokenItem: undefined });

    const res = await postRefresh({ refreshToken: randomUUID() });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid refresh token");
  });

  // ── Behaviour: wrong type → 401 ──────────────────────────────────────────

  it("returns 401 when token has wrong type", async () => {
    setupDynamoMock({ tokenItem: makeTokenItem({ type: "oauth_state" }) });

    const res = await postRefresh({ refreshToken: randomUUID() });

    expect(res.status).toBe(401);
  });

  // ── Behaviour: expired TTL → 401 ─────────────────────────────────────────

  it("returns 401 with 'Refresh token expired' when TTL is in the past", async () => {
    setupDynamoMock({
      tokenItem: makeTokenItem({ ttl: Math.floor(Date.now() / 1000) - 1 }),
    });

    const res = await postRefresh({ refreshToken: randomUUID() });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Refresh token expired");
  });

  // ── Behaviour: superseded token → 401 + all user tokens deleted ──────────

  it("returns 401 with 'Token reuse detected' and deletes all user tokens when conditional update fails", async () => {
    const tokenHashA = "token-hash-a";
    const tokenHashB = "token-hash-b";

    setupDynamoMock({
      tokenItem: makeTokenItem(),
      updateShouldFail: true,
      scanPages: [
        [
          { token: tokenHashA, userId: USER_ID },
          { token: tokenHashB, userId: USER_ID },
        ],
      ],
    });

    const res = await postRefresh({ refreshToken: randomUUID() });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Token reuse detected");

    const deleteCalls = mockSend.mock.calls.filter(([cmd]) => cmd instanceof DeleteCommand);
    expect(deleteCalls).toHaveLength(2);
    const deletedKeys = deleteCalls.map(
      ([cmd]) => (cmd as { input: { Key: { token: string } } }).input.Key.token,
    );
    expect(deletedKeys).toContain(tokenHashA);
    expect(deletedKeys).toContain(tokenHashB);
  });

  it("returns 401 with 'Token reuse detected' on concurrent token reuse (TOCTOU)", async () => {
    setupDynamoMock({
      tokenItem: makeTokenItem(),
      updateShouldFail: true,
      scanPages: [[]],
    });

    const res = await postRefresh({ refreshToken: randomUUID() });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Token reuse detected");
  });

  it("scans the refresh tokens table by userId when detecting token reuse", async () => {
    setupDynamoMock({
      tokenItem: makeTokenItem(),
      updateShouldFail: true,
      scanPages: [[]],
    });

    await postRefresh({ refreshToken: randomUUID() });

    const scanCalls = mockSend.mock.calls.filter(([cmd]) => cmd instanceof ScanCommand);
    expect(scanCalls).toHaveLength(1);
    const [scanCmd] = scanCalls[0] as [
      {
        input: {
          TableName: string;
          FilterExpression: string;
          ExpressionAttributeValues: { [key: string]: unknown };
        };
      },
    ];
    expect(scanCmd.input.TableName).toBe(REFRESH_TOKENS_TABLE);
    expect(scanCmd.input.ExpressionAttributeValues[":userId"]).toBe(USER_ID);
  });

  it("follows scan pagination when purging all user tokens", async () => {
    const tokenHashA = "token-hash-a";
    const tokenHashB = "token-hash-b";

    setupDynamoMock({
      tokenItem: makeTokenItem(),
      updateShouldFail: true,
      scanPages: [
        [{ token: tokenHashA, userId: USER_ID }],
        [{ token: tokenHashB, userId: USER_ID }],
      ],
    });

    await postRefresh({ refreshToken: randomUUID() });

    const scanCalls = mockSend.mock.calls.filter(([cmd]) => cmd instanceof ScanCommand);
    expect(scanCalls).toHaveLength(2);

    const secondScanCmd = (scanCalls[1] as [{ input: { ExclusiveStartKey?: unknown } }])[0];
    expect(secondScanCmd.input.ExclusiveStartKey).toBeDefined();

    const deleteCalls = mockSend.mock.calls.filter(([cmd]) => cmd instanceof DeleteCommand);
    expect(deleteCalls).toHaveLength(2);
    const deletedKeys = deleteCalls.map(
      ([cmd]) => (cmd as { input: { Key: { token: string } } }).input.Key.token,
    );
    expect(deletedKeys).toContain(tokenHashA);
    expect(deletedKeys).toContain(tokenHashB);
  });

  // ── Behaviour: valid rotation → 200 with new tokens ──────────────────────

  it("returns 200 with jwt and refreshToken on valid token", async () => {
    setupDynamoMock({ tokenItem: makeTokenItem() });

    const res = await postRefresh({ refreshToken: randomUUID() });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jwt: string; refreshToken: string };
    expect(typeof body.jwt).toBe("string");
    expect(body.jwt.length).toBeGreaterThan(0);
    expect(typeof body.refreshToken).toBe("string");
    expect(body.refreshToken.length).toBeGreaterThan(0);
  });

  it("issues an RS256 JWT with correct claims on valid rotation", async () => {
    setupDynamoMock({ tokenItem: makeTokenItem() });

    const before = Math.floor(Date.now() / 1000);
    const res = await postRefresh({ refreshToken: randomUUID() });
    const after = Math.floor(Date.now() / 1000);

    const body = (await res.json()) as { jwt: string };
    const publicKey = await importSPKI(publicKeyPem, "RS256");
    const { payload, protectedHeader } = await jwtVerify(body.jwt, publicKey, {
      issuer: "petroglyph-api",
      audience: "petroglyph-plugin",
    });

    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.sub).toBe(USER_ID);
    expect(payload["username"]).toBe(USERNAME);
    expect(payload.iss).toBe("petroglyph-api");
    expect(payload.aud).toBe("petroglyph-plugin");
    expect(payload.exp).toBeGreaterThanOrEqual(before + 3600);
    expect(payload.exp).toBeLessThanOrEqual(after + 3600);
  });

  // ── Behaviour: old token marked superseded on rotation ───────────────────

  it("marks the old token as superseded during rotation", async () => {
    const raw = randomUUID();
    const hash = createHash("sha256").update(raw).digest("hex");
    setupDynamoMock({ tokenItem: { ...makeTokenItem(), token: hash } });

    await postRefresh({ refreshToken: raw });

    const updateCalls = mockSend.mock.calls.filter(([cmd]) => cmd instanceof UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const [updateCmd] = updateCalls[0] as [
      {
        input: {
          Key: { token: string };
          ExpressionAttributeValues: { [key: string]: unknown };
        };
      },
    ];
    expect(updateCmd.input.Key.token).toBe(hash);
    expect(updateCmd.input.ExpressionAttributeValues[":true"]).toBe(true);
  });

  // ── Behaviour: new refresh token stored in DynamoDB ───────────────────────

  it("stores a hashed new refresh token in DynamoDB with 90-day TTL", async () => {
    setupDynamoMock({ tokenItem: makeTokenItem() });

    const before = Math.floor(Date.now() / 1000);
    const res = await postRefresh({ refreshToken: randomUUID() });
    const after = Math.floor(Date.now() / 1000);

    const body = (await res.json()) as { refreshToken: string };

    const putCalls = mockSend.mock.calls.filter(([cmd]) => cmd instanceof PutCommand);
    expect(putCalls).toHaveLength(1);
    const [putCmd] = putCalls[0] as [
      {
        input: {
          TableName: string;
          Item: { token: string; type: string; userId: string; ttl: number };
        };
      },
    ];
    expect(putCmd.input.TableName).toBe(REFRESH_TOKENS_TABLE);
    expect(putCmd.input.Item.type).toBe("refresh_token");
    expect(putCmd.input.Item.userId).toBe(USER_ID);

    const expectedHash = createHash("sha256").update(body.refreshToken).digest("hex");
    expect(putCmd.input.Item.token).toBe(expectedHash);

    const ninetyDays = 90 * 24 * 60 * 60;
    expect(putCmd.input.Item.ttl).toBeGreaterThanOrEqual(before + ninetyDays);
    expect(putCmd.input.Item.ttl).toBeLessThanOrEqual(after + ninetyDays);
  });
});

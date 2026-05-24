import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppVariables } from "./auth-middleware.js";

const mockDbSend = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

import { onedriveMiddleware } from "./onedrive-middleware.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCESS_TOKEN = "existing-access-token";
const REFRESH_TOKEN = "existing-refresh-token";
const NEW_ACCESS_TOKEN = "new-access-token";
const NEW_REFRESH_TOKEN = "new-refresh-token";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setupDbMock(tokenExpirySecondsOffset: number): void {
  const expirySeconds = Math.floor((Date.now() + tokenExpirySecondsOffset) / 1000);
  mockDbSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      return Promise.resolve({
        Item: {
          accessToken: ACCESS_TOKEN,
          refreshToken: REFRESH_TOKEN,
          expirySeconds,
        },
      });
    }
    if (cmd instanceof UpdateCommand) {
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
}

function setupFetchMock(
  overrides: Partial<{
    ok: boolean;
    status: number;
    body: unknown;
  }> = {},
): void {
  const { ok = true, status = 200, body } = overrides;
  const responseBody = body ?? {
    access_token: NEW_ACCESS_TOKEN,
    refresh_token: NEW_REFRESH_TOKEN,
    expires_in: 3600,
  };
  mockFetch.mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(responseBody),
  });
}

function makeTestApp(): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-42");
    c.set("username", "octocat");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await onedriveMiddleware(c as unknown as Context<{ Variables: AppVariables }>, next);
  });
  app.get("/test", (c) => c.json({ token: c.get("onedriveAccessToken") ?? null }));
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("onedriveMiddleware", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-client-secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mockDbSend.mockReset();
    mockFetch.mockReset();
  });

  describe("token not near expiry", () => {
    it("passes through without refreshing and sets access token in context", async () => {
      setupDbMock(30 * 60 * 1000); // 30 min away

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(ACCESS_TOKEN);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("token within 10 minutes of expiry", () => {
    it("refreshes the token and sets new access token in context", async () => {
      setupDbMock(5 * 60 * 1000); // 5 min away
      setupFetchMock();

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(NEW_ACCESS_TOKEN);
    });

    it("POSTs to Microsoft token endpoint with correct params", async () => {
      setupDbMock(5 * 60 * 1000);
      setupFetchMock();

      const app = makeTestApp();
      await app.request("/test");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [
        string,
        { method: string; headers: { [key: string]: string }; body: string },
      ];
      expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
      expect(init.method).toBe("POST");

      const params = new URLSearchParams(init.body);
      expect(params.get("client_id")).toBe("test-client-id");
      expect(params.get("client_secret")).toBe("test-client-secret");
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe(REFRESH_TOKEN);
      expect(params.get("scope")).toBe("files.read offline_access");
    });

    it("writes new tokens back to DynamoDB", async () => {
      setupDbMock(5 * 60 * 1000);
      setupFetchMock();

      const app = makeTestApp();
      await app.request("/test");

      const updateCalls = mockDbSend.mock.calls.filter(([cmd]) => cmd instanceof UpdateCommand);
      expect(updateCalls).toHaveLength(1);
      const updateInput = (
        updateCalls[0] as [
          {
            input: {
              ExpressionAttributeValues: { [key: string]: unknown };
            };
          },
        ]
      )[0].input;
      expect(updateInput.ExpressionAttributeValues[":accessToken"]).toBe(NEW_ACCESS_TOKEN);
      expect(updateInput.ExpressionAttributeValues[":refreshToken"]).toBe(NEW_REFRESH_TOKEN);
      expect(typeof updateInput.ExpressionAttributeValues[":expirySeconds"]).toBe("number");
    });
  });

  describe("token already expired", () => {
    it("refreshes when token is already past its expiry", async () => {
      setupDbMock(-60 * 1000); // 1 min ago
      setupFetchMock();

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(NEW_ACCESS_TOKEN);
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe("DynamoDB read error", () => {
    it("passes through with undefined token when DynamoDB read fails", async () => {
      mockDbSend.mockRejectedValue(new Error("DynamoDB unavailable"));

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: null };
      expect(body.token).toBeNull();
    });
  });

  describe("Microsoft refresh API error", () => {
    it("passes through with old access token when Microsoft returns non-ok response", async () => {
      setupDbMock(5 * 60 * 1000);
      setupFetchMock({ ok: false, status: 500 });

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(ACCESS_TOKEN);
    });

    it("passes through with old access token when fetch throws", async () => {
      setupDbMock(5 * 60 * 1000);
      mockFetch.mockRejectedValue(new Error("network error"));

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(ACCESS_TOKEN);
    });
  });

  describe("Microsoft token response validation", () => {
    it("passes through with old token when response is missing access_token", async () => {
      setupDbMock(5 * 60 * 1000);
      setupFetchMock({
        body: { refresh_token: NEW_REFRESH_TOKEN, expires_in: 3600 },
      });

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(ACCESS_TOKEN);
    });

    it("passes through with old token when response is missing refresh_token", async () => {
      setupDbMock(5 * 60 * 1000);
      setupFetchMock({
        body: { access_token: NEW_ACCESS_TOKEN, expires_in: 3600 },
      });

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(ACCESS_TOKEN);
    });

    it("passes through with old token when expires_in is not a number", async () => {
      setupDbMock(5 * 60 * 1000);
      setupFetchMock({
        body: {
          access_token: NEW_ACCESS_TOKEN,
          refresh_token: NEW_REFRESH_TOKEN,
          expires_in: "3600",
        },
      });

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(ACCESS_TOKEN);
    });

    it("passes through with old token when response is not an object", async () => {
      setupDbMock(5 * 60 * 1000);
      setupFetchMock({ body: "unexpected string" });

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(ACCESS_TOKEN);
    });
  });
});

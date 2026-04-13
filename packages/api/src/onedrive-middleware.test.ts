import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import type { Context } from "hono";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppVariables } from "./auth-middleware.js";

const mockSsmSend = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("./ssm.js", () => ({
  ssmClient: { send: mockSsmSend },
}));

import { onedriveMiddleware } from "./onedrive-middleware.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCESS_TOKEN = "existing-access-token";
const REFRESH_TOKEN = "existing-refresh-token";
const NEW_ACCESS_TOKEN = "new-access-token";
const NEW_REFRESH_TOKEN = "new-refresh-token";

const SSM_ACCESS_TOKEN = "/petroglyph/onedrive/access-token";
const SSM_TOKEN_EXPIRY = "/petroglyph/onedrive/token-expiry";
const SSM_REFRESH_TOKEN = "/petroglyph/onedrive/refresh-token";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expiryInFuture(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function setupSsmMock(tokenExpiry: string): void {
  mockSsmSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetParameterCommand) {
      const name = (cmd as { input: { Name: string } }).input.Name;
      if (name === SSM_ACCESS_TOKEN) {
        return Promise.resolve({ Parameter: { Value: ACCESS_TOKEN } });
      }
      if (name === SSM_TOKEN_EXPIRY) {
        return Promise.resolve({ Parameter: { Value: tokenExpiry } });
      }
      if (name === SSM_REFRESH_TOKEN) {
        return Promise.resolve({ Parameter: { Value: REFRESH_TOKEN } });
      }
    }
    if (cmd instanceof PutParameterCommand) {
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
  app.use("*", (c, next) =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    onedriveMiddleware(c as unknown as Context<{ Variables: AppVariables }>, next),
  );
  app.get("/test", (c) => c.json({ token: c.get("onedriveAccessToken") ?? null }));
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("onedriveMiddleware", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client-id");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mockSsmSend.mockReset();
    mockFetch.mockReset();
  });

  describe("token not near expiry", () => {
    it("passes through without refreshing and sets access token in context", async () => {
      const expiry = expiryInFuture(30 * 60 * 1000); // 30 min away
      setupSsmMock(expiry);

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
      const expiry = expiryInFuture(5 * 60 * 1000); // 5 min away
      setupSsmMock(expiry);
      setupFetchMock();

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(NEW_ACCESS_TOKEN);
    });

    it("POSTs to Microsoft token endpoint with correct params", async () => {
      const expiry = expiryInFuture(5 * 60 * 1000);
      setupSsmMock(expiry);
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
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe(REFRESH_TOKEN);
      expect(params.get("scope")).toBe("files.read offline_access");
    });

    it("writes new tokens back to SSM with Overwrite=true", async () => {
      const expiry = expiryInFuture(5 * 60 * 1000);
      setupSsmMock(expiry);
      setupFetchMock();

      const app = makeTestApp();
      await app.request("/test");

      const putCalls = mockSsmSend.mock.calls.filter(([cmd]) => cmd instanceof PutParameterCommand);
      expect(putCalls).toHaveLength(3);

      const putInputs = putCalls.map(
        ([cmd]) => (cmd as { input: { Name: string; Value: string; Overwrite: boolean } }).input,
      );

      const accessTokenPut = putInputs.find((i) => i.Name === SSM_ACCESS_TOKEN);
      expect(accessTokenPut?.Value).toBe(NEW_ACCESS_TOKEN);
      expect(accessTokenPut?.Overwrite).toBe(true);

      const refreshTokenPut = putInputs.find((i) => i.Name === SSM_REFRESH_TOKEN);
      expect(refreshTokenPut?.Value).toBe(NEW_REFRESH_TOKEN);
      expect(refreshTokenPut?.Overwrite).toBe(true);

      const expiryPut = putInputs.find((i) => i.Name === SSM_TOKEN_EXPIRY);
      expect(expiryPut?.Overwrite).toBe(true);
      expect(typeof expiryPut?.Value).toBe("string");
      if (expiryPut === undefined) throw new Error("expiryPut should be defined");
      expect(() => new Date(expiryPut.Value)).not.toThrow();
    });
  });

  describe("token already expired", () => {
    it("refreshes when token is already past its expiry", async () => {
      const expiry = expiryInFuture(-60 * 1000); // 1 min ago
      setupSsmMock(expiry);
      setupFetchMock();

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(NEW_ACCESS_TOKEN);
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe("SSM read error", () => {
    it("passes through with undefined token when SSM read fails", async () => {
      mockSsmSend.mockRejectedValue(new Error("SSM unavailable"));

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: null };
      expect(body.token).toBeNull();
    });
  });

  describe("Microsoft refresh API error", () => {
    it("passes through with old access token when Microsoft returns non-ok response", async () => {
      const expiry = expiryInFuture(5 * 60 * 1000);
      setupSsmMock(expiry);
      setupFetchMock({ ok: false, status: 500 });

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(ACCESS_TOKEN);
    });

    it("passes through with old access token when fetch throws", async () => {
      const expiry = expiryInFuture(5 * 60 * 1000);
      setupSsmMock(expiry);
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
      const expiry = expiryInFuture(5 * 60 * 1000);
      setupSsmMock(expiry);
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
      const expiry = expiryInFuture(5 * 60 * 1000);
      setupSsmMock(expiry);
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
      const expiry = expiryInFuture(5 * 60 * 1000);
      setupSsmMock(expiry);
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
      const expiry = expiryInFuture(5 * 60 * 1000);
      setupSsmMock(expiry);
      setupFetchMock({ body: "unexpected string" });

      const app = makeTestApp();
      const res = await app.request("/test");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string };
      expect(body.token).toBe(ACCESS_TOKEN);
    });
  });
});

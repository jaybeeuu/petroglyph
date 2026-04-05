import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mockSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("./db.js", () => ({
  docClient: { send: mockSend },
}));

import { app } from "./app.js";
import { authMiddleware, type AppVariables } from "./auth-middleware.js";
import { resetKeyCache } from "./jwt.js";

describe("auth middleware", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetKeyCache();
  });

  async function makeValidToken(
    claims: Record<string, unknown> = {},
  ): Promise<string> {
    return new SignJWT({ username: "testuser", ...claims })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  describe("missing or malformed Authorization header", () => {
    it("returns 401 when Authorization header is absent", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "UNAUTHORIZED" });
    });

    it("returns 401 when Authorization header is not Bearer scheme", async () => {
      const res = await app.request("/health", {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "UNAUTHORIZED" });
    });
  });

  describe("invalid JWT", () => {
    it("returns 401 for expired JWT", async () => {
      const token = await new SignJWT({ username: "testuser" })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("user-123")
        .setIssuedAt()
        .setExpirationTime(new Date(Date.now() - 60_000))
        .sign(privateKey);

      const res = await app.request("/health", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "UNAUTHORIZED" });
    });

    it("returns 401 for JWT signed with a different key", async () => {
      const wrongKeyPair = await generateKeyPair("RS256");
      const token = await new SignJWT({ username: "testuser" })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("user-123")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(wrongKeyPair.privateKey);

      const res = await app.request("/health", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "UNAUTHORIZED" });
    });
  });

  describe("valid JWT", () => {
    it("passes through to the route handler", async () => {
      const token = await makeValidToken();
      const res = await app.request("/health", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    });

    it("populates userId and username on Hono context", async () => {
      const testApp = new Hono<{ Variables: AppVariables }>();
      testApp.use("*", authMiddleware);
      testApp.get("/whoami", (c) =>
        c.json({ userId: c.get("userId"), username: c.get("username") }),
      );

      const token = await makeValidToken();
      const res = await testApp.request("/whoami", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { userId: string; username: string };
      expect(body.userId).toBe("user-123");
      expect(body.username).toBe("testuser");
    });
  });

  describe("exempt routes", () => {
    it("does not require auth for GET /auth/url", async () => {
      vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
      vi.stubEnv("GITHUB_REDIRECT_URI", "obsidian://petroglyph/auth/callback");

      const res = await app.request("/auth/url");
      expect(res.status).toBe(200);
    });
  });
});

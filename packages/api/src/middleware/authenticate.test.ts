import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authenticate } from "./authenticate.js";
import { MockAuthProvider } from "../auth/mock-provider.js";
import { fail } from "@petroglyph/core";
import type { Result } from "@petroglyph/core";
import type { EntraTokenClaims } from "../auth/claims.js";
import type { AuthError } from "../auth/errors.js";
import type { AuthProvider } from "../auth/provider.js";

// A controllable stub AuthProvider for testing specific failure modes.
const makeStubProvider = (result: Result<EntraTokenClaims, AuthError>): AuthProvider => ({
  validateToken: async () => Promise.resolve(result),
});

const makeApp = (provider: AuthProvider): Hono => {
  const app = new Hono();
  app.use(authenticate(provider));
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
};

describe("authenticate middleware", () => {
  it("returns 401 with missing_token when Authorization header is absent", async () => {
    const app = makeApp(new MockAuthProvider());
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("missing_token");
  });

  it("returns 401 with missing_token when Authorization header is not a bearer", async () => {
    const app = makeApp(new MockAuthProvider());
    const res = await app.request("/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("missing_token");
  });

  it("returns 401 with missing_token for an empty bearer token", async () => {
    const app = makeApp(new MockAuthProvider());
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("missing_token");
  });

  it("returns 401 with the provider error reason for an invalid token", async () => {
    const provider = makeStubProvider(fail({ kind: "invalid_token", detail: "bad sig" }));
    const app = makeApp(provider);
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer bad-token" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("invalid_token");
  });

  it("returns 401 for an expired token", async () => {
    const provider = makeStubProvider(fail({ kind: "expired_token" }));
    const app = makeApp(provider);
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer expired-token" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("expired_token");
  });

  it("calls next and returns 200 for a valid token", async () => {
    const provider = new MockAuthProvider();
    const app = makeApp(provider);
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer valid-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

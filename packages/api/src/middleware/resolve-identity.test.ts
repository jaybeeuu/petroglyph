import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { resolveIdentity } from "./resolve-identity.js";
import { authenticate } from "./authenticate.js";
import { MockAuthProvider, MOCK_OID } from "../auth/mock-provider.js";
import { InMemoryAccountRepository } from "../account/in-memory-repository.js";
import { fixtureUser, fixtureIdentity } from "../account/fixtures.js";
import { asApplicationUserId, asAuthIdentityId } from "@petroglyph/core";
import type { ApplicationUser, AuthIdentity } from "@petroglyph/account";
import { getAuthContext } from "./auth-context.js";

const makeApp = (
  users: ApplicationUser[] = [],
  identities: AuthIdentity[] = [],
): Hono => {
  const repository = new InMemoryAccountRepository(users, identities);
  const provider = new MockAuthProvider();
  const app = new Hono();
  app.use(authenticate(provider));
  app.use(resolveIdentity(repository));
  app.get("/test", (c) => {
    const { user } = getAuthContext(c);
    return c.json({ userId: user.id, status: user.status });
  });
  return app;
};

const bearerHeader = (token: string): { Authorization: string } => ({
  Authorization: `Bearer ${token}`,
});

describe("resolveIdentity middleware", () => {
  it("returns 401 with unknown_identity when no auth identity record exists for the oid", async () => {
    const app = makeApp([], []);
    const res = await app.request("/test", { headers: bearerHeader("any-token") });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("unknown_identity");
  });

  it("returns 401 with unknown_identity when an identity exists but user record is missing", async () => {
    // Identity record exists but no corresponding user record.
    const identityWithoutUser: AuthIdentity = {
      id: asAuthIdentityId("orphan-identity"),
      userId: asApplicationUserId("non-existent-user"),
      provider: "entra",
      externalId: MOCK_OID,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const app = makeApp([], [identityWithoutUser]);
    const res = await app.request("/test", { headers: bearerHeader("any-token") });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("unknown_identity");
  });

  it("returns 401 with disabled_account when the linked user is disabled", async () => {
    const disabledUser: ApplicationUser = {
      ...fixtureUser,
      status: "disabled",
    };
    const app = makeApp([disabledUser], [fixtureIdentity]);
    const res = await app.request("/test", { headers: bearerHeader("any-token") });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("disabled_account");
  });

  it("resolves successfully and sets the auth context for a known active user", async () => {
    const app = makeApp([fixtureUser], [fixtureIdentity]);
    const res = await app.request("/test", { headers: bearerHeader("any-token") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; status: string };
    expect(body.userId).toBe(fixtureUser.id);
    expect(body.status).toBe("active");
  });

  it("returns 401 when called without the authenticate middleware having run first", async () => {
    // resolveIdentity is called without tokenClaims in context.
    const repository = new InMemoryAccountRepository([fixtureUser], [fixtureIdentity]);
    const app = new Hono();
    app.use(resolveIdentity(repository));
    app.get("/test", (c) => c.json({ ok: true }));
    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });
});

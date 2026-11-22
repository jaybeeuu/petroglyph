import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** The mocked DynamoDB call, typed at the edge so a test can read what was asked. */
const mockSend = vi.hoisted(() =>
  vi.fn<(command: { input?: unknown }) => Promise<{ Item?: unknown }>>(() => Promise.resolve({})),
);

vi.mock("./db.js", () => ({
  docClient: () => ({ send: mockSend }),
}));

import { createApp } from "./index.js";
import { resetKeyCache } from "./jwt.js";

describe("staging delivery auth middleware", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("STAGED_PDFS_BUCKET", "petroglyph-staged-pdfs-test");
    app = createApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetKeyCache();
  });

  async function makeValidToken(claims: { [key: string]: unknown } = {}): Promise<string> {
    return new SignJWT({ username: "testuser", ...claims })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  it("returns 401 when the Authorization header is absent", async () => {
    const res = await app.request("/profiles/p1/files");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHORIZED" });
  });

  it("returns 401 when the Authorization header is not a Bearer scheme", async () => {
    const res = await app.request("/profiles/p1/files", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired JWT", async () => {
    const token = await new SignJWT({ username: "testuser" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime(new Date(Date.now() - 60_000))
      .sign(privateKey);

    const res = await app.request("/profiles/p1/files", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a JWT signed with a different key", async () => {
    const wrongKeyPair = await generateKeyPair("RS256");
    const token = await new SignJWT({ username: "testuser" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(wrongKeyPair.privateKey as CryptoKey);

    const res = await app.request("/profiles/p1/files", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid token and reads the profile the token's userId names", async () => {
    const token = await makeValidToken();
    mockSend.mockResolvedValueOnce({
      Item: {
        profileId: "p1",
        userId: "user-123",
        name: "Main",
        sourceFolderPath: "notes",
        pollingIntervalMinutes: 5,
        enabled: true,
        active: true,
        initialSyncEnabled: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    });

    const res = await app.request("/profiles/p1/files", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [], nextToken: null });
    const read = z
      .object({ input: z.object({ Key: z.object({ userId: z.string(), profileId: z.string() }) }) })
      .parse(mockSend.mock.calls[0]?.[0]);
    expect(read.input.Key).toEqual({ userId: "user-123", profileId: "p1" });
  });
});

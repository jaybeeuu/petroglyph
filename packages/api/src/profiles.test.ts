import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncProfile } from "@petroglyph/core";

const mockListProfiles = vi.hoisted(() => vi.fn<() => Promise<SyncProfile[]>>());
const mockPutProfile = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("@petroglyph/core", () => ({
  listProfiles: mockListProfiles,
  putProfile: mockPutProfile,
}));

vi.mock("./db.js", () => ({
  docClient: {},
}));

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

describe("/profiles", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("SYNC_PROFILES_TABLE", "test-sync-profiles");
    resetKeyCache();
    mockListProfiles.mockResolvedValue([]);
    mockPutProfile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetKeyCache();
  });

  async function makeValidToken(userId = "user-42", username = "octocat"): Promise<string> {
    return new SignJWT({ username })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(userId)
      .setIssuer("petroglyph-api")
      .setAudience("petroglyph-plugin")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  const existingProfile: SyncProfile = {
    profileId: "existing-profile-id",
    userId: "user-42",
    name: "My Profile",
    sourceFolderPath: "/source",
    destinationVaultPath: "/vault",
    pollingIntervalMinutes: 5,
    enabled: true,
    active: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  describe("GET /profiles", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await app.request("/profiles");
      expect(res.status).toBe(401);
    });

    it("returns empty array when user has no profiles", async () => {
      mockListProfiles.mockResolvedValue([]);
      const token = await makeValidToken("user-42");

      const res = await app.request("/profiles", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("returns only profiles for the authenticated user", async () => {
      mockListProfiles.mockResolvedValue([existingProfile]);
      const token = await makeValidToken("user-42");

      const res = await app.request("/profiles", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([existingProfile]);
      expect(mockListProfiles).toHaveBeenCalledWith(
        expect.anything(),
        "test-sync-profiles",
        "user-42",
      );
    });

    it("passes the authenticated userId to listProfiles", async () => {
      const token = await makeValidToken("user-99");

      await app.request("/profiles", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(mockListProfiles).toHaveBeenCalledWith(
        expect.anything(),
        "test-sync-profiles",
        "user-99",
      );
    });
  });

  describe("POST /profiles", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await app.request("/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          sourceFolderPath: "/src",
          destinationVaultPath: "/dst",
        }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for missing required fields", async () => {
      const token = await makeValidToken();

      const res = await app.request("/profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Test" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid body (not JSON)", async () => {
      const token = await makeValidToken();

      const res = await app.request("/profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "not-json",
      });

      expect(res.status).toBe(400);
    });

    it("creates a profile with a generated UUID and correct defaults", async () => {
      const token = await makeValidToken("user-42");

      const res = await app.request("/profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "My Profile",
          sourceFolderPath: "/source",
          destinationVaultPath: "/vault",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as SyncProfile;
      expect(body.profileId).toBeDefined();
      expect(body.profileId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.userId).toBe("user-42");
      expect(body.name).toBe("My Profile");
      expect(body.sourceFolderPath).toBe("/source");
      expect(body.destinationVaultPath).toBe("/vault");
      expect(body.pollingIntervalMinutes).toBe(5);
      expect(body.enabled).toBe(true);
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
    });

    it("sets active: true when this is the first profile for the user", async () => {
      mockListProfiles.mockResolvedValue([]);
      const token = await makeValidToken("user-42");

      const res = await app.request("/profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "First Profile",
          sourceFolderPath: "/source",
          destinationVaultPath: "/vault",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as SyncProfile;
      expect(body.active).toBe(true);
    });

    it("sets active: false when other profiles already exist", async () => {
      mockListProfiles.mockResolvedValue([existingProfile]);
      const token = await makeValidToken("user-42");

      const res = await app.request("/profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Second Profile",
          sourceFolderPath: "/source2",
          destinationVaultPath: "/vault2",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as SyncProfile;
      expect(body.active).toBe(false);
    });

    it("respects optional pollingIntervalMinutes and enabled fields", async () => {
      const token = await makeValidToken("user-42");

      const res = await app.request("/profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Custom Profile",
          sourceFolderPath: "/source",
          destinationVaultPath: "/vault",
          pollingIntervalMinutes: 10,
          enabled: false,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as SyncProfile;
      expect(body.pollingIntervalMinutes).toBe(10);
      expect(body.enabled).toBe(false);
    });

    it("writes the profile to the database", async () => {
      const token = await makeValidToken("user-42");

      await app.request("/profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "My Profile",
          sourceFolderPath: "/source",
          destinationVaultPath: "/vault",
        }),
      });

      expect(mockPutProfile).toHaveBeenCalledWith(
        expect.anything(),
        "test-sync-profiles",
        expect.objectContaining({ userId: "user-42", name: "My Profile" }),
      );
    });
  });
});

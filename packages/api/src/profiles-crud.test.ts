import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncProfile } from "@petroglyph/core";

const mockGetProfile = vi.hoisted(() => vi.fn());
const mockListProfiles = vi.hoisted(() => vi.fn());
const mockPutProfile = vi.hoisted(() => vi.fn());
const mockDeleteProfile = vi.hoisted(() => vi.fn());
const mockDbSend = vi.hoisted(() => vi.fn());

vi.mock("@petroglyph/core", () => ({
  getProfile: mockGetProfile,
  listProfiles: mockListProfiles,
  putProfile: mockPutProfile,
  deleteProfile: mockDeleteProfile,
}));

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

function makeProfile(overrides: Partial<SyncProfile> = {}): SyncProfile {
  return {
    profileId: "profile-1",
    userId: "user-42",
    name: "My Profile",
    sourceFolderPath: "/source",
    destinationVaultPath: "/vault",
    pollingIntervalMinutes: 5,
    enabled: true,
    active: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("profiles CRUD handlers", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("SYNC_PROFILES_TABLE", "petroglyph-sync-profiles-test");
    vi.stubEnv("FILE_RECORDS_TABLE", "petroglyph-file-records-test");
    mockGetProfile.mockReset();
    mockListProfiles.mockReset();
    mockPutProfile.mockReset();
    mockDeleteProfile.mockReset();
    mockDbSend.mockReset();
    resetKeyCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetKeyCache();
  });

  async function makeToken(userId = "user-42", username = "octocat"): Promise<string> {
    return new SignJWT({ username })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(userId)
      .setIssuer("petroglyph-api")
      .setAudience("petroglyph-plugin")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  async function request(
    method: string,
    path: string,
    body?: unknown,
    userId = "user-42",
  ): Promise<Response> {
    const token = await makeToken(userId);
    return app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  describe("GET /profiles/:id", () => {
    it("returns the profile when found and owned by the authenticated user", async () => {
      const profile = makeProfile();
      mockGetProfile.mockResolvedValue(profile);

      const response = await request("GET", "/profiles/profile-1");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(profile);
    });

    it("returns 404 when the profile does not exist", async () => {
      mockGetProfile.mockResolvedValue(null);

      const response = await request("GET", "/profiles/profile-1");

      expect(response.status).toBe(404);
    });

    it("returns 404 when the profile belongs to a different user", async () => {
      const profile = makeProfile({ userId: "other-user" });
      mockGetProfile.mockResolvedValue(profile);

      const response = await request("GET", "/profiles/profile-1");

      expect(response.status).toBe(404);
    });

    it("returns 401 when no auth token is provided", async () => {
      const response = await app.request("/profiles/profile-1");
      expect(response.status).toBe(401);
    });
  });

  describe("PUT /profiles/:id", () => {
    it("merges partial updates and sets updatedAt", async () => {
      const existing = makeProfile({ name: "Old Name" });
      mockGetProfile.mockResolvedValue(existing);
      mockPutProfile.mockResolvedValue(undefined);

      const response = await request("PUT", "/profiles/profile-1", { name: "New Name" });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SyncProfile;
      expect(body.name).toBe("New Name");
      expect(body.sourceFolderPath).toBe(existing.sourceFolderPath);
      expect(body.updatedAt).not.toBe(existing.updatedAt);
      expect(mockPutProfile).toHaveBeenCalledOnce();
    });

    it("returns 404 when profile not found", async () => {
      mockGetProfile.mockResolvedValue(null);

      const response = await request("PUT", "/profiles/profile-1", { name: "New Name" });

      expect(response.status).toBe(404);
    });

    it("returns 404 when profile belongs to a different user", async () => {
      const profile = makeProfile({ userId: "other-user" });
      mockGetProfile.mockResolvedValue(profile);

      const response = await request("PUT", "/profiles/profile-1", { name: "New Name" });

      expect(response.status).toBe(404);
    });

    it("returns 400 for invalid body fields", async () => {
      const existing = makeProfile();
      mockGetProfile.mockResolvedValue(existing);

      const response = await request("PUT", "/profiles/profile-1", {
        pollingIntervalMinutes: -1,
      });

      expect(response.status).toBe(400);
    });

    it("accepts partial updates with multiple fields", async () => {
      const existing = makeProfile();
      mockGetProfile.mockResolvedValue(existing);
      mockPutProfile.mockResolvedValue(undefined);

      const response = await request("PUT", "/profiles/profile-1", {
        enabled: false,
        pollingIntervalMinutes: 10,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SyncProfile;
      expect(body.enabled).toBe(false);
      expect(body.pollingIntervalMinutes).toBe(10);
    });
  });

  describe("DELETE /profiles/:id", () => {
    it("deletes the profile and returns 204", async () => {
      const profile = makeProfile();
      mockGetProfile.mockResolvedValue(profile);
      mockDeleteProfile.mockResolvedValue(undefined);
      mockListProfiles.mockResolvedValue([]);
      mockDbSend.mockResolvedValue({ Items: [] });

      const response = await request("DELETE", "/profiles/profile-1");

      expect(response.status).toBe(204);
      expect(mockDeleteProfile).toHaveBeenCalledOnce();
    });

    it("returns 404 when profile not found", async () => {
      mockGetProfile.mockResolvedValue(null);

      const response = await request("DELETE", "/profiles/profile-1");

      expect(response.status).toBe(404);
    });

    it("returns 404 when profile belongs to a different user", async () => {
      const profile = makeProfile({ userId: "other-user" });
      mockGetProfile.mockResolvedValue(profile);

      const response = await request("DELETE", "/profiles/profile-1");

      expect(response.status).toBe(404);
    });

    it("promotes the most-recently-created other profile to active when deleted profile was active", async () => {
      const deletedProfile = makeProfile({ active: true, profileId: "profile-1" });
      const olderProfile = makeProfile({
        profileId: "profile-2",
        createdAt: "2023-01-01T00:00:00.000Z",
        active: false,
      });
      const newerProfile = makeProfile({
        profileId: "profile-3",
        createdAt: "2024-06-01T00:00:00.000Z",
        active: false,
      });

      mockGetProfile.mockResolvedValue(deletedProfile);
      mockDeleteProfile.mockResolvedValue(undefined);
      mockDbSend.mockResolvedValue({ Items: [] });
      mockListProfiles.mockResolvedValue([olderProfile, newerProfile]);
      mockPutProfile.mockResolvedValue(undefined);

      const response = await request("DELETE", "/profiles/profile-1");

      expect(response.status).toBe(204);
      expect(mockPutProfile).toHaveBeenCalledOnce();
      const promoted = mockPutProfile.mock.calls[0]?.[2] as SyncProfile;
      expect(promoted.profileId).toBe("profile-3");
      expect(promoted.active).toBe(true);
    });

    it("does not promote any profile when no other profiles exist", async () => {
      const activeProfile = makeProfile({ active: true });
      mockGetProfile.mockResolvedValue(activeProfile);
      mockDeleteProfile.mockResolvedValue(undefined);
      mockDbSend.mockResolvedValue({ Items: [] });
      mockListProfiles.mockResolvedValue([]);

      const response = await request("DELETE", "/profiles/profile-1");

      expect(response.status).toBe(204);
      expect(mockPutProfile).not.toHaveBeenCalled();
    });

    it("does not promote any profile when deleted profile was not active", async () => {
      const profile = makeProfile({ active: false });
      const other = makeProfile({ profileId: "profile-2", active: true });
      mockGetProfile.mockResolvedValue(profile);
      mockDeleteProfile.mockResolvedValue(undefined);
      mockDbSend.mockResolvedValue({ Items: [] });
      mockListProfiles.mockResolvedValue([other]);

      const response = await request("DELETE", "/profiles/profile-1");

      expect(response.status).toBe(204);
      expect(mockPutProfile).not.toHaveBeenCalled();
    });

    it("deletes file_records for the profile", async () => {
      const profile = makeProfile();
      mockGetProfile.mockResolvedValue(profile);
      mockDeleteProfile.mockResolvedValue(undefined);
      mockListProfiles.mockResolvedValue([]);
      mockDbSend
        .mockResolvedValueOnce({
          Items: [{ profileId: "profile-1", fileId: "file-a" }],
        })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ Items: [] });

      const response = await request("DELETE", "/profiles/profile-1");

      expect(response.status).toBe(204);
      const dbCalls = mockDbSend.mock.calls;
      const queryCall = dbCalls.find(
        (call) => (call[0] as { input?: unknown }) instanceof QueryCommand,
      );
      expect(queryCall).toBeDefined();
      const deleteCall = dbCalls.find(
        (call) =>
          (call[0] as { input?: unknown }) instanceof DeleteCommand &&
          (call[0] as { input: { Key: { fileId: string } } }).input.Key.fileId === "file-a",
      );
      expect(deleteCall).toBeDefined();
    });
  });
});

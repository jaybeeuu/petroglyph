import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("./db.js", () => ({
  docClient: () => ({ send: mockSend }),
}));

import { createApp } from "./app.js";
import { resetKeyCache } from "./jwt.js";

const app = createApp();

describe("GET /status", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;

  /** A stored profile row, with every attribute the profile schema names. */
  interface ProfileRow {
    [attribute: string]: unknown;
  }

  function createProfileRow(overrides: ProfileRow & { profileId: string }): ProfileRow {
    return {
      userId: "user-42",
      name: "A profile",
      sourceFolderPath: "Notes",
      destinationVaultPath: "vault",
      pollingIntervalMinutes: 5,
      enabled: true,
      active: true,
      initialSyncEnabled: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  interface StatusCommand {
    input: {
      TableName: string;
      KeyConditionExpression?: string;
      Key?: { [attribute: string]: unknown };
    };
  }

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    resetKeyCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetKeyCache();
  });

  function mockStatusReads(options?: {
    syncProfileItem?: { [key: string]: unknown };
    userItem?: { [key: string]: unknown };
    profiles?: ProfileRow[];
    subscriptionStates?: { [profileId: string]: string };
    rejectSyncProfile?: boolean;
    rejectProfiles?: boolean;
  }): void {
    mockSend.mockImplementation((command: StatusCommand) => {
      const tableName = command.input.TableName;

      if (tableName === "petroglyph-sync-profiles-default") {
        if (command.input.KeyConditionExpression !== undefined) {
          if (options?.rejectProfiles) {
            return Promise.reject(new Error("SyncProfiles unavailable"));
          }
          return Promise.resolve({ Items: options?.profiles ?? [] });
        }
        if (options?.rejectSyncProfile) {
          return Promise.reject(new Error("SyncProfile unavailable"));
        }
        return Promise.resolve({ Item: options?.syncProfileItem });
      }

      if (tableName === "petroglyph-graph-subscriptions-default") {
        const profileId = (command.input.Key as { profileId: string }).profileId;
        const subscriptionState = options?.subscriptionStates?.[profileId];
        return Promise.resolve(
          subscriptionState === undefined
            ? {}
            : { Item: { profileId, provider: "onedrive", subscriptionState } },
        );
      }

      if (tableName === "petroglyph-users-default") {
        return Promise.resolve({ Item: options?.userItem });
      }

      return Promise.resolve({});
    });
  }

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

  describe("authenticated request", () => {
    it("returns 200 with github connected status and username", async () => {
      mockStatusReads();
      const token = await makeValidToken("user-42", "octocat");

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        github: { connected: true, username: "octocat" },
        oneDrive: { connected: false },
        oneDriveStatus: "never_connected",
      });
    });

    it("returns connected status when SyncProfile has oneDriveConnected=true", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: true,
        },
      });
      const token = await makeValidToken("user-42");

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        oneDrive: { connected: boolean };
        oneDriveStatus: string;
      };
      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected");
    });

    it("returns never_connected when no SyncProfile exists", async () => {
      mockStatusReads();
      const token = await makeValidToken();

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        oneDrive: { connected: boolean };
        oneDriveStatus: string;
      };
      expect(body.oneDrive.connected).toBe(false);
      expect(body.oneDriveStatus).toBe("never_connected");
    });

    it("returns reconnect_required when a SyncProfile exists but is disconnected", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: false,
        },
      });
      const token = await makeValidToken();

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        oneDrive: { connected: boolean };
        oneDriveStatus: string;
      };
      expect(body.oneDrive.connected).toBe(false);
      expect(body.oneDriveStatus).toBe("reconnect_required");
    });

    it("reports reconnect_required when every live profile's subscription has failed", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: true,
        },
        profiles: [
          createProfileRow({ profileId: "profile-a" }),
          createProfileRow({ profileId: "profile-b" }),
        ],
        subscriptionStates: { "profile-a": "failed", "profile-b": "failed" },
      });
      const token = await makeValidToken();

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        oneDrive: { connected: boolean };
        oneDriveStatus: string;
      };
      expect(body.oneDrive.connected).toBe(false);
      expect(body.oneDriveStatus).toBe("reconnect_required");
    });

    it("reports connected when one live profile's subscription is active", async () => {
      mockStatusReads({
        syncProfileItem: { userId: "user-42", profileId: "default", oneDriveConnected: false },
        profiles: [
          createProfileRow({ profileId: "profile-failed" }),
          createProfileRow({ profileId: "profile-active" }),
        ],
        subscriptionStates: { "profile-failed": "failed", "profile-active": "active" },
      });
      const token = await makeValidToken();

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        oneDrive: { connected: boolean };
        oneDriveStatus: string;
      };
      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected");
    });

    it("does not report reconnect_required when one live profile's subscription is pending", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: true,
        },
        profiles: [
          createProfileRow({ profileId: "profile-failed" }),
          createProfileRow({ profileId: "profile-pending" }),
        ],
        subscriptionStates: { "profile-failed": "failed", "profile-pending": "pending" },
      });
      const token = await makeValidToken();

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        oneDrive: { connected: boolean };
        oneDriveStatus: string;
      };
      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected");
    });

    it("ignores a soft-deleted profile's failed subscription", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: true,
        },
        profiles: [
          createProfileRow({ profileId: "profile-gone", deletedAt: "2024-06-01T00:00:00.000Z" }),
        ],
        subscriptionStates: { "profile-gone": "failed" },
      });
      const token = await makeValidToken();

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        oneDrive: { connected: boolean };
        oneDriveStatus: string;
      };
      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected");
    });

    it("ignores the stored reconnect_required on the user record", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: true,
        },
        userItem: { userId: "user-42", oneDriveStatus: "reconnect_required" },
      });
      const token = await makeValidToken();

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        oneDrive: { connected: boolean };
        oneDriveStatus: string;
      };
      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected");
    });

    it("falls back to the SyncProfile when the profile list cannot be read", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: true,
        },
        rejectProfiles: true,
      });
      const token = await makeValidToken();

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        oneDrive: { connected: boolean };
        oneDriveStatus: string;
      };
      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected");
    });

    it("returns oneDrive.connected false when the SyncProfile lookup fails", async () => {
      mockStatusReads({ rejectSyncProfile: true });
      const token = await makeValidToken();

      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        oneDrive: { connected: boolean };
        oneDriveStatus: string;
      };
      expect(body.oneDrive.connected).toBe(false);
      expect(body.oneDriveStatus).toBe("never_connected");
    });
  });

  describe("unauthenticated request", () => {
    it("returns 401 when no Authorization header", async () => {
      const res = await app.request("/status");

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "UNAUTHORIZED" });
    });

    it("returns 401 when Authorization header is not Bearer", async () => {
      const res = await app.request("/status", {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "UNAUTHORIZED" });
    });
  });
});

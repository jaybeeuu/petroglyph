import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("./db.js", () => ({
  docClient: { send: mockSend },
}));

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

describe("GET /status", () => {
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
    rejectSyncProfile?: boolean;
    rejectUser?: boolean;
  }): void {
    mockSend.mockImplementation((command: { input: { TableName: string } }) => {
      const tableName = command.input.TableName;

      if (tableName === "petroglyph-sync-profiles-default") {
        if (options?.rejectSyncProfile) {
          return Promise.reject(new Error("SyncProfile unavailable"));
        }
        return Promise.resolve({ Item: options?.syncProfileItem });
      }

      if (tableName === "petroglyph-users-default") {
        if (options?.rejectUser) {
          return Promise.reject(new Error("Users table unavailable"));
        }
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

    it("returns connected when reconnect_required is stale after a successful reconnect", async () => {
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

    it("normalizes disconnected from the user record to reconnect_required", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: false,
        },
        userItem: { userId: "user-42", oneDriveStatus: "disconnected" },
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

    it("ignores stale never_connected from the user record when a SyncProfile is disconnected", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: false,
        },
        userItem: { userId: "user-42", oneDriveStatus: "never_connected" },
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

    it("ignores stale connected from the user record when a SyncProfile is disconnected", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: false,
        },
        userItem: { userId: "user-42", oneDriveStatus: "connected" },
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

    it("falls back to SyncProfile state when the user lookup fails", async () => {
      mockStatusReads({
        syncProfileItem: {
          userId: "user-42",
          profileId: "default",
          oneDriveConnected: true,
        },
        rejectUser: true,
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

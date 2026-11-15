import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("./db.js", () => ({
  docClient: () => ({ send: mockSend }),
}));

import { createApp } from "./app.js";
import { resetKeyCache } from "./jwt.js";

const app = createApp();

const TOKEN_VAULTS_TABLE = "petroglyph-token-vaults-status-test";
const SYNC_PROFILES_TABLE = "petroglyph-sync-profiles-status-test";
const USERS_TABLE = "petroglyph-users-status-test";

interface StatusBody {
  oneDrive: { connected: boolean };
  oneDriveStatus: string;
}

interface ProfileRow {
  profileId: string;
  oneDriveConnected?: boolean;
}

function makeProfile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return { profileId: "profile-1", ...overrides };
}

function makeConnectionRow(overrides: { reconnectRequired?: boolean } = {}): object {
  return {
    userId: "user-42",
    provider: "onedrive",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expirySeconds: 1_900_000_000,
    updatedAt: "2026-11-15T00:00:00.000Z",
    reconnectRequired: false,
    ...overrides,
  };
}

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
    vi.stubEnv("TOKEN_VAULTS_TABLE", TOKEN_VAULTS_TABLE);
    vi.stubEnv("SYNC_PROFILES_TABLE", SYNC_PROFILES_TABLE);
    vi.stubEnv("USERS_TABLE", USERS_TABLE);
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    resetKeyCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetKeyCache();
  });

  function mockStatusReads(options?: {
    connectionItem?: object;
    profiles?: ProfileRow[];
    userItem?: object;
    rejectConnection?: boolean;
    rejectProfiles?: boolean;
    rejectUser?: boolean;
  }): void {
    mockSend.mockImplementation((command: { input: { TableName: string } }) => {
      const tableName = command.input.TableName;

      if (tableName === TOKEN_VAULTS_TABLE) {
        if (options?.rejectConnection === true) {
          return Promise.reject(new Error("Token vault unavailable"));
        }
        return Promise.resolve({ Item: options?.connectionItem });
      }

      if (tableName === SYNC_PROFILES_TABLE) {
        if (options?.rejectProfiles === true) {
          return Promise.reject(new Error("SyncProfiles unavailable"));
        }
        const profiles = options?.profiles ?? [];
        return Promise.resolve({ Items: profiles, Count: profiles.length });
      }

      if (tableName === USERS_TABLE) {
        if (options?.rejectUser === true) {
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

  async function getStatus(): Promise<StatusBody> {
    const token = await makeValidToken();

    const res = await app.request("/status", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    return (await res.json()) as StatusBody;
  }

  describe("authenticated request", () => {
    it("returns 200 with github connected status and username", async () => {
      mockStatusReads();

      const token = await makeValidToken("user-42", "octocat");
      const res = await app.request("/status", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        github: { connected: true, username: "octocat" },
        oneDrive: { connected: false },
        oneDriveStatus: "never_connected",
      });
    });

    it("reports never_connected when the connection was never established", async () => {
      mockStatusReads();

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(false);
      expect(body.oneDriveStatus).toBe("never_connected");
    });

    it("reports connected_no_profile for a live connection with no profile", async () => {
      mockStatusReads({ connectionItem: makeConnectionRow() });

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected_no_profile");
    });

    it("reports connected_no_profile when only the user record knows the connection", async () => {
      mockStatusReads({ userItem: { userId: "user-42", oneDriveStatus: "connected" } });

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected_no_profile");
    });

    it("reports connected for a live connection with a profile", async () => {
      mockStatusReads({ connectionItem: makeConnectionRow(), profiles: [makeProfile()] });

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected");
    });

    it("reports reconnect_required when the vault row requires a reconnect", async () => {
      mockStatusReads({
        connectionItem: makeConnectionRow({ reconnectRequired: true }),
        profiles: [makeProfile()],
      });

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(false);
      expect(body.oneDriveStatus).toBe("reconnect_required");
    });

    it("reports reconnect_required when the user record requires a reconnect", async () => {
      mockStatusReads({ userItem: { userId: "user-42", oneDriveStatus: "reconnect_required" } });

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(false);
      expect(body.oneDriveStatus).toBe("reconnect_required");
    });

    it("normalizes a stored disconnected user record to reconnect_required", async () => {
      mockStatusReads({
        connectionItem: makeConnectionRow(),
        userItem: { userId: "user-42", oneDriveStatus: "disconnected" },
      });

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(false);
      expect(body.oneDriveStatus).toBe("reconnect_required");
    });

    it("reports never_connected for a profile with no connection behind it", async () => {
      // The regression this design removes: a profile row used to decide the
      // connection state, so a profile outlived the grant and read connected.
      mockStatusReads({ profiles: [makeProfile({ oneDriveConnected: true })] });

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(false);
      expect(body.oneDriveStatus).toBe("never_connected");
    });

    it("keeps the status when a profile is edited", async () => {
      mockStatusReads({
        connectionItem: makeConnectionRow(),
        profiles: [makeProfile({ oneDriveConnected: true })],
      });
      const before = await getStatus();

      // A profile edit changes its attributes only; the connection is untouched.
      mockStatusReads({
        connectionItem: makeConnectionRow(),
        profiles: [makeProfile({ oneDriveConnected: false })],
      });
      const after = await getStatus();

      expect(after).toEqual(before);
      expect(after.oneDriveStatus).toBe("connected");
    });

    it("keeps the status when a profile is added", async () => {
      mockStatusReads({ connectionItem: makeConnectionRow(), profiles: [makeProfile()] });
      const before = await getStatus();

      mockStatusReads({
        connectionItem: makeConnectionRow(),
        profiles: [makeProfile(), makeProfile({ profileId: "profile-2" })],
      });
      const after = await getStatus();

      expect(after).toEqual(before);
      expect(after.oneDriveStatus).toBe("connected");
    });

    it("keeps the status when a profile is deleted", async () => {
      mockStatusReads({
        connectionItem: makeConnectionRow(),
        profiles: [makeProfile(), makeProfile({ profileId: "profile-2" })],
      });
      const before = await getStatus();

      mockStatusReads({ connectionItem: makeConnectionRow(), profiles: [makeProfile()] });
      const after = await getStatus();

      expect(after).toEqual(before);
      expect(after.oneDriveStatus).toBe("connected");
    });

    it("stays connected when the profile lookup fails", async () => {
      mockStatusReads({ connectionItem: makeConnectionRow(), rejectProfiles: true });

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected");
    });

    it("reports never_connected when the connection lookup fails", async () => {
      mockStatusReads({ rejectConnection: true, rejectUser: true });

      const body = await getStatus();

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

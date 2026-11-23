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
    userItem?: object;
    rejectConnection?: boolean;
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
        // A profile row always exists here, so any handler that consulted the
        // table would answer `connected`. `/status` must ignore it.
        return Promise.resolve({ Items: [{ profileId: "profile-1" }], Count: 1 });
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
      mockStatusReads({
        connectionItem: makeConnectionRow(),
        userItem: { userId: "user-42", hasProfile: true },
      });

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(true);
      expect(body.oneDriveStatus).toBe("connected");
    });

    it("reports reconnect_required when the vault row requires a reconnect", async () => {
      mockStatusReads({
        connectionItem: makeConnectionRow({ reconnectRequired: true }),
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

    it("reports never_connected for a profile with no connection behind it", async () => {
      // The regression this design removes: a profile row used to decide the
      // connection state, so a profile outlived the grant and read connected.
      mockStatusReads({ userItem: { userId: "user-42", hasProfile: true } });

      const body = await getStatus();

      expect(body.oneDrive.connected).toBe(false);
      expect(body.oneDriveStatus).toBe("never_connected");
    });

    it("reads no sync_profiles row", async () => {
      mockStatusReads({ connectionItem: makeConnectionRow() });

      await getStatus();

      const tables = mockSend.mock.calls.map(
        (call) => (call[0] as { input: { TableName: string } }).input.TableName,
      );
      expect(tables).not.toContain(SYNC_PROFILES_TABLE);
    });

    it("keeps the connection when the first profile is created", async () => {
      mockStatusReads({
        connectionItem: makeConnectionRow(),
        userItem: { userId: "user-42", oneDriveStatus: "connected" },
      });
      const before = await getStatus();

      mockStatusReads({
        connectionItem: makeConnectionRow(),
        userItem: { userId: "user-42", oneDriveStatus: "connected", hasProfile: true },
      });
      const after = await getStatus();

      expect(before.oneDriveStatus).toBe("connected_no_profile");
      expect(after.oneDriveStatus).toBe("connected");
      expect(after.oneDrive.connected).toBe(before.oneDrive.connected);
      expect(after.oneDrive.connected).toBe(true);
    });

    it("keeps the connection when the last profile is deleted", async () => {
      mockStatusReads({
        connectionItem: makeConnectionRow(),
        userItem: { userId: "user-42", oneDriveStatus: "connected", hasProfile: true },
      });
      const before = await getStatus();

      mockStatusReads({
        connectionItem: makeConnectionRow(),
        userItem: { userId: "user-42", oneDriveStatus: "connected", hasProfile: false },
      });
      const after = await getStatus();

      expect(before.oneDriveStatus).toBe("connected");
      expect(after.oneDriveStatus).toBe("connected_no_profile");
      expect(after.oneDrive.connected).toBe(before.oneDrive.connected);
      expect(after.oneDrive.connected).toBe(true);
    });

    it("reports connected when the user record read fails", async () => {
      // An unknown presence mark must not tell a user to create a profile.
      mockStatusReads({ connectionItem: makeConnectionRow(), rejectUser: true });

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

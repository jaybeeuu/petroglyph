import { BatchWriteCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: () => ({ send: mockDbSend }),
}));

import { createApp } from "./app.js";
import { resetKeyCache } from "./jwt.js";

const app = createApp();

const FILE_RECORDS_TABLE = "petroglyph-file-records-test";
const DELTA_TOKENS_TABLE = "petroglyph-delta-tokens-test";
const SYNC_PROFILES_TABLE = "petroglyph-sync-profiles-test";

const PROFILE_ONE = "b6f1c0de-0000-4000-8000-000000000001";
const PROFILE_TWO = "b6f1c0de-0000-4000-8000-000000000002";

interface ProfileRow {
  profileId: string;
  userId: string;
}

function makeProfile(profileId: string): object {
  return {
    profileId,
    userId: "user-42",
    name: `profile ${profileId}`,
    sourceFolderPath: "docs",
    destinationVaultPath: "inbox",
    pollingIntervalMinutes: 5,
    enabled: true,
    active: false,
    initialSyncEnabled: true,
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
  };
}

describe("POST /sync/reset", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("FILE_RECORDS_TABLE", FILE_RECORDS_TABLE);
    vi.stubEnv("DELTA_TOKENS_TABLE", DELTA_TOKENS_TABLE);
    vi.stubEnv("SYNC_PROFILES_TABLE", SYNC_PROFILES_TABLE);
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
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

  async function postReset(scope: unknown): Promise<Response> {
    const token = await makeToken();

    return app.request("/sync/reset", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scope }),
    });
  }

  /**
   * Answers the three tables the reset touches: the caller's profiles, each
   * profile's file records, and the delta tokens.
   */
  function mockTables(options: {
    profiles: ProfileRow[];
    fileRecordIds?: { [profileId: string]: string[] };
    batchWriteResponses?: object[];
  }): void {
    const { profiles, fileRecordIds = {}, batchWriteResponses = [] } = options;

    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof QueryCommand) {
        if (command.input.TableName === SYNC_PROFILES_TABLE) {
          return Promise.resolve({ Items: profiles.map((row) => makeProfile(row.profileId)) });
        }
        const profileId = command.input.ExpressionAttributeValues?.[":profileId"] as
          | string
          | undefined;
        if (profileId === undefined) {
          return Promise.reject(new Error("file records query without a profile id"));
        }
        return Promise.resolve({
          Items: (fileRecordIds[profileId] ?? []).map((fileId) => ({ profileId, fileId })),
        });
      }

      if (command instanceof BatchWriteCommand) {
        return Promise.resolve(batchWriteResponses.shift() ?? {});
      }

      if (command instanceof DeleteCommand) {
        return Promise.resolve({});
      }

      return Promise.resolve({});
    });
  }

  function deltaTokenDeletes(): DeleteCommand[] {
    const commands: DeleteCommand[] = [];
    for (const [command] of mockDbSend.mock.calls) {
      if (command instanceof DeleteCommand) commands.push(command);
    }
    return commands;
  }

  function fileRecordBatches(): BatchWriteCommand[] {
    const commands: BatchWriteCommand[] = [];
    for (const [command] of mockDbSend.mock.calls) {
      if (command instanceof BatchWriteCommand) commands.push(command);
    }
    return commands;
  }

  it("returns 400 for an invalid scope", async () => {
    const response = await postReset("plugin");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid reset scope",
    });
  });

  it("deletes the delta token and file records of every profile the user owns", async () => {
    mockTables({
      profiles: [{ profileId: PROFILE_ONE, userId: "user-42" }],
      fileRecordIds: { [PROFILE_ONE]: ["file-1", "file-2"] },
    });

    const response = await postReset("server");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resetToken: false });

    const deletes = deltaTokenDeletes();
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.input.TableName).toBe(DELTA_TOKENS_TABLE);
    expect(deletes[0]?.input.Key).toEqual({ profileId: PROFILE_ONE });

    const batches = fileRecordBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.input.RequestItems?.[FILE_RECORDS_TABLE]).toEqual([
      { DeleteRequest: { Key: { profileId: PROFILE_ONE, fileId: "file-1" } } },
      { DeleteRequest: { Key: { profileId: PROFILE_ONE, fileId: "file-2" } } },
    ]);
  });

  it("resets each profile separately and retries unprocessed file records", async () => {
    mockTables({
      profiles: [
        { profileId: PROFILE_ONE, userId: "user-42" },
        { profileId: PROFILE_TWO, userId: "user-42" },
      ],
      fileRecordIds: {
        [PROFILE_ONE]: ["file-1"],
        [PROFILE_TWO]: ["file-2"],
      },
      batchWriteResponses: [
        {},
        {
          UnprocessedItems: {
            [FILE_RECORDS_TABLE]: [
              { DeleteRequest: { Key: { profileId: PROFILE_TWO, fileId: "file-2" } } },
            ],
          },
        },
        {},
      ],
    });

    const response = await postReset("server");

    expect(response.status).toBe(200);

    const deletes = deltaTokenDeletes();
    expect(deletes.map((command) => command.input.Key)).toEqual([
      { profileId: PROFILE_ONE },
      { profileId: PROFILE_TWO },
    ]);

    const batches = fileRecordBatches();
    expect(batches.map((command) => command.input.RequestItems?.[FILE_RECORDS_TABLE]?.[0])).toEqual(
      [
        { DeleteRequest: { Key: { profileId: PROFILE_ONE, fileId: "file-1" } } },
        { DeleteRequest: { Key: { profileId: PROFILE_TWO, fileId: "file-2" } } },
        { DeleteRequest: { Key: { profileId: PROFILE_TWO, fileId: "file-2" } } },
      ],
    );
  });

  it("deletes nothing for a user with no profile", async () => {
    mockTables({ profiles: [] });

    const response = await postReset("full");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resetToken: true });
    expect(deltaTokenDeletes()).toHaveLength(0);
    expect(fileRecordBatches()).toHaveLength(0);
  });

  it("returns resetToken=true for a full reset after clearing server state", async () => {
    mockTables({
      profiles: [{ profileId: PROFILE_ONE, userId: "user-42" }],
      fileRecordIds: { [PROFILE_ONE]: ["file-9"] },
    });

    const response = await postReset("full");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resetToken: true });

    expect(deltaTokenDeletes()).toHaveLength(1);
    expect(fileRecordBatches()).toHaveLength(1);
  });
});

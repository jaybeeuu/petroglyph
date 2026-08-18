import type { PutCommandInput } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

describe("POST /sync/run", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("SYNC_JOBS_TABLE", "petroglyph-sync-jobs-test");
    vi.stubEnv("SYNC_PROFILES_TABLE", "petroglyph-sync-profiles-test");
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

  async function postSyncRun(): Promise<Response> {
    const token = await makeToken();
    return app.request("/sync/run", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  function mockOneDriveDb(): void {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        return Promise.resolve({ Item: undefined });
      }
      if (command instanceof PutCommand) {
        return Promise.resolve({});
      }
      if (command instanceof QueryCommand) {
        const tableName = command.input.TableName;
        if (tableName?.includes("sync-profile")) {
          return Promise.resolve({
            Items: [
              {
                profileId: "default",
                userId: "user-42",
                name: "default",
                sourceFolderPath: "OnyxBoox",
                destinationVaultPath: "handwritten",
                pollingIntervalMinutes: 5,
                enabled: true,
                active: true,
                initialSyncEnabled: true,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
              },
            ],
          });
        }
        return Promise.resolve({ Items: [] });
      }
      return Promise.resolve({});
    });
  }

  it("returns 201 Created with jobId when dispatching a sync job", async () => {
    mockOneDriveDb();

    const response = await postSyncRun();

    expect(response.status).toBe(201);
    const body = (await response.json()) as { jobId: string };
    expect(body.jobId).toBeDefined();
    expect(typeof body.jobId).toBe("string");
    expect(body.jobId.length).toBeGreaterThan(0);
  });

  it("creates exactly one job record in the sync-jobs table with status queued", async () => {
    mockOneDriveDb();

    const response = await postSyncRun();
    const { jobId } = (await response.json()) as { jobId: string };

    const putCalls = mockDbSend.mock.calls.filter(([command]) => command instanceof PutCommand);
    expect(putCalls).toHaveLength(1);

    expect(mockDbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "petroglyph-sync-jobs-test",
          Item: expect.objectContaining({
            jobId,
            profileId: "default",
            sourceFolderPath: "OnyxBoox",
            userId: "user-42",
            status: "queued",
            createdAt: expect.any(String) as unknown as string,
          }) as unknown as PutCommandInput["Item"],
        }) as unknown as PutCommandInput,
      }),
    );
  });

  it("does not perform the Graph delta walk", async () => {
    mockOneDriveDb();

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await postSyncRun();

    // Should not call fetch for Graph API
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 400 when the profile record is missing required fields", async () => {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof QueryCommand) {
        return Promise.resolve({
          Items: [
            {
              profileId: "default",
              userId: "user-42",
              sourceFolderPath: "OnyxBoox",
              active: true,
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    const response = await postSyncRun();

    expect(response.status).toBe(400);
  });

  it("returns 400 when no active profile is configured", async () => {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof QueryCommand) {
        return Promise.resolve({ Items: [] });
      }
      return Promise.resolve({});
    });

    const response = await postSyncRun();

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("No active profile configured");
  });
});

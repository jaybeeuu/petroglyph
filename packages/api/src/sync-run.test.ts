import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());
const mockSqsSend = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

vi.mock("@aws-sdk/client-sqs", () => {
  const mockSend = mockSqsSend;
  return {
    SQSClient: class {
      send = mockSend;
    },
    SendMessageCommand: class {
      constructor(public input: unknown) {}
    },
  };
});

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
    vi.stubEnv(
      "SYNC_JOB_QUEUE_URL",
      "https://sqs.eu-west-2.amazonaws.com/123456789/petroglyph-sync-jobs-test",
    );
    vi.stubEnv("SYNC_PROFILES_TABLE", "petroglyph-sync-profiles-test");
    mockDbSend.mockReset();
    mockSqsSend.mockReset();
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
    mockSqsSend.mockResolvedValue({});

    const response = await postSyncRun();

    expect(response.status).toBe(201);
    const body = (await response.json()) as { jobId: string };
    expect(body.jobId).toBeDefined();
    expect(typeof body.jobId).toBe("string");
    expect(body.jobId.length).toBeGreaterThan(0);
  });

  it("creates a job record in sync-jobs table with status queued", async () => {
    mockOneDriveDb();
    mockSqsSend.mockResolvedValue({});

    await postSyncRun();

    const putCalls = mockDbSend.mock.calls.filter(([command]) => command instanceof PutCommand);
    expect(putCalls.length).toBeGreaterThan(0);

    const syncJobPut = putCalls.find(
      ([command]) =>
        (command as { input: { TableName: string } }).input.TableName ===
        "petroglyph-sync-jobs-test",
    );
    expect(syncJobPut).toBeDefined();

    const [syncJobCommand] = syncJobPut as [
      {
        input: {
          TableName: string;
          Item: {
            jobId: string;
            profileId: string;
            status: string;
            createdAt: string;
          };
        };
      },
    ];
    expect(syncJobCommand.input.Item.jobId).toBeDefined();
    expect(syncJobCommand.input.Item.profileId).toBe("default");
    expect(syncJobCommand.input.Item.status).toBe("queued");
    expect(syncJobCommand.input.Item.createdAt).toBeDefined();
  });

  it("sends a message to the sync-job queue", async () => {
    mockOneDriveDb();
    mockSqsSend.mockResolvedValue({});

    const response = await postSyncRun();
    const { jobId } = (await response.json()) as { jobId: string };

    expect(mockSqsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          QueueUrl: "https://sqs.eu-west-2.amazonaws.com/123456789/petroglyph-sync-jobs-test",
          MessageBody: JSON.stringify({
            jobId,
            profileId: "default",
            sourceFolderPath: "OnyxBoox",
            userId: "user-42",
          }),
        }) as unknown as SendMessageCommandInput,
      }),
    );
  });

  it("does not perform the Graph delta walk", async () => {
    mockOneDriveDb();
    mockSqsSend.mockResolvedValue({});

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
    mockSqsSend.mockResolvedValue({});

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

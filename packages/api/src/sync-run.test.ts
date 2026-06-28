import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

vi.stubGlobal("fetch", mockFetch);

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

describe("POST /sync/run", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;
  const accessToken = "onedrive-access-token";
  const refreshToken = "onedrive-refresh-token";

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("ONEDRIVE_FOLDER", "OnyxBoox");
    vi.stubEnv("FILE_RECORDS_TABLE", "petroglyph-file-records-test");
    vi.stubEnv("DELTA_TOKENS_TABLE", "petroglyph-delta-tokens-test");
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-client-secret");
    mockDbSend.mockReset();
    mockFetch.mockReset();
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

function mockOneDriveDb({
    tokenExpiryOffsetMs = 60 * 60 * 1000,
    onedriveAccessToken = accessToken,
    onedriveRefreshToken = refreshToken,
    deltaToken,
  }: {
    tokenExpiryOffsetMs?: number;
    onedriveAccessToken?: string;
    onedriveRefreshToken?: string;
    deltaToken?: string;
  } = {}): void {
    const expirySeconds = Math.floor((Date.now() + tokenExpiryOffsetMs) / 1000);
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        const tableName = command.input.TableName;
        if (tableName === "petroglyph-delta-tokens-test") {
          if (deltaToken !== undefined) {
            return Promise.resolve({
              Item: { profileId: "default", deltaToken },
            });
          }
          return Promise.resolve({ Item: undefined });
        }
        // For OneDrive tokens or any other GetCommand
        return Promise.resolve({
          Item: {
            accessToken: onedriveAccessToken,
            refreshToken: onedriveRefreshToken,
            expirySeconds,
          },
        });
      }
      if (command instanceof PutCommand || command instanceof UpdateCommand) {
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

  it("queues PDF items on a first run when no delta token exists", async () => {
    mockOneDriveDb();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          value: [
            {
              id: "pdf-1",
              name: "notes.pdf",
              file: { mimeType: "application/pdf" },
            },
            {
              id: "txt-1",
              name: "notes.txt",
              file: { mimeType: "text/plain" },
            },
          ],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=delta-token-1",
        }),
    });

    const response = await postSyncRun();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: 1 });

    const [firstFetchUrl, firstFetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(firstFetchUrl).toBe("https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta");
    expect(firstFetchOptions.method).toBe("GET");
    expect((firstFetchOptions.headers as { Authorization: string }).Authorization).toBe(
      "Bearer onedrive-access-token",
    );

    const putItemCalls = mockDbSend.mock.calls.filter(([command]) => command instanceof PutCommand);
    expect(putItemCalls).toHaveLength(2); // 1 file record + 1 delta token

    // Check file record
    const fileRecordPut = putItemCalls.find(
      ([cmd]) => (cmd as { input: { TableName: string; Item: { fileId?: string } } }).input.Item.fileId,
    );
    const [fileRecordCommand] = fileRecordPut as [
      {
        input: {
          TableName: string;
          Item: {
            profileId: string;
            fileId: string;
            s3Key: string;
            filename: string;
            createdAt: string;
            status: string;
          };
        };
      },
    ];
    expect(fileRecordCommand.input.TableName).toBe("petroglyph-file-records-test");
    expect(fileRecordCommand.input.Item.profileId).toBe("default");
    expect(fileRecordCommand.input.Item.fileId).toBe("pdf-1");
    expect(fileRecordCommand.input.Item.s3Key).toBe("");
    expect(fileRecordCommand.input.Item.filename).toBe("notes.pdf");
    expect(fileRecordCommand.input.Item.status).toBe("pending");
    expect(typeof fileRecordCommand.input.Item.createdAt).toBe("string");

    // Check delta token
    const deltaTokenPut = putItemCalls.find(
      ([cmd]) => (cmd as { input: { TableName: string; Item: { deltaToken?: string } } }).input.Item.deltaToken,
    );
    const [deltaTokenCommand] = deltaTokenPut as [
      { input: { TableName: string; Item: { profileId: string; deltaToken: string; updatedAt: string } } },
    ];
    expect(deltaTokenCommand.input.TableName).toBe("petroglyph-delta-tokens-test");
    expect(deltaTokenCommand.input.Item.profileId).toBe("default");
    expect(deltaTokenCommand.input.Item.deltaToken).toBe("delta-token-1");
  });

  it("continues an incremental sync from the stored delta token across pages", async () => {
    mockOneDriveDb({ deltaToken: "delta-token-1" });
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            value: [
              {
                id: "pdf-2",
                name: "meeting-notes.pdf",
                file: { mimeType: "application/pdf" },
              },
            ],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?$skiptoken=page-2",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            value: [
              {
                id: "pdf-3",
                name: "diagram.pdf",
                file: { mimeType: "application/pdf" },
              },
              {
                id: "png-1",
                name: "diagram.png",
                file: { mimeType: "image/png" },
              },
            ],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=delta-token-2",
          }),
      });

    const response = await postSyncRun();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: 2 });

    const [incrementalFetchUrl, incrementalFetchOptions] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(incrementalFetchUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=delta-token-1",
    );
    expect(incrementalFetchOptions.method).toBe("GET");
    expect((incrementalFetchOptions.headers as { Authorization: string }).Authorization).toBe(
      "Bearer onedrive-access-token",
    );

    const [nextPageFetchUrl, nextPageFetchOptions] = mockFetch.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(nextPageFetchUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?$skiptoken=page-2",
    );
    expect(nextPageFetchOptions.method).toBe("GET");

    const putItemCalls = mockDbSend.mock.calls.filter(([command]) => command instanceof PutCommand);
    expect(putItemCalls).toHaveLength(3); // 2 file records + 1 delta token

    const queuedFileIds = putItemCalls
      .filter(
        ([command]) =>
          (command as { input: { Item: { fileId?: string } } }).input.Item.fileId !== undefined,
      )
      .map(
        ([command]) =>
          (
            command as {
              input: { Item: { fileId: string } };
            }
          ).input.Item.fileId,
      );
    expect(queuedFileIds).toEqual(["pdf-2", "pdf-3"]);

    // Check delta token was updated
    const deltaTokenPut = putItemCalls.find(
      ([cmd]) => (cmd as { input: { Item: { deltaToken?: string } } }).input.Item.deltaToken,
    );
    const [deltaTokenCommand] = deltaTokenPut as [
      { input: { TableName: string; Item: { profileId: string; deltaToken: string } } },
    ];
    expect(deltaTokenCommand.input.TableName).toBe("petroglyph-delta-tokens-test");
    expect(deltaTokenCommand.input.Item.deltaToken).toBe("delta-token-2");
  });

  it("returns queued=0 when the delta query contains no new PDF items", async () => {
    mockOneDriveDb({ deltaToken: "delta-token-2" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          value: [
            {
              id: "folder-1",
              name: "Meeting Notes",
              folder: { childCount: 2 },
            },
            {
              id: "deleted-pdf",
              name: "old-notes.pdf",
              file: { mimeType: "application/pdf" },
              deleted: {},
            },
          ],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=delta-token-3",
        }),
    });

    const response = await postSyncRun();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: 0 });

    const putItemCalls = mockDbSend.mock.calls.filter(([command]) => command instanceof PutCommand);
    expect(putItemCalls).toHaveLength(1); // 1 delta token (no file records)

    // Check delta token was updated
    const deltaTokenPut = putItemCalls.find(
      ([cmd]) => (cmd as { input: { Item: { deltaToken?: string } } }).input.Item.deltaToken,
    );
    const [deltaTokenCommand] = deltaTokenPut as [
      { input: { TableName: string; Item: { profileId: string; deltaToken: string } } },
    ];
    expect(deltaTokenCommand.input.TableName).toBe("petroglyph-delta-tokens-test");
    expect(deltaTokenCommand.input.Item.profileId).toBe("default");
    expect(deltaTokenCommand.input.Item.deltaToken).toBe("delta-token-3");
  });

  it("refreshes an expiring access token before querying Graph", async () => {
    mockOneDriveDb({
      tokenExpiryOffsetMs: 5 * 60 * 1000,
      onedriveRefreshToken: "onedrive-refresh-token",
    });
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "fresh-access-token",
            refresh_token: "fresh-refresh-token",
            expires_in: 3600,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            value: [
              {
                id: "pdf-4",
                name: "renewed-notes.pdf",
                file: { mimeType: "application/pdf" },
              },
            ],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=delta-token-4",
          }),
      });

    const response = await postSyncRun();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: 1 });

    const [refreshUrl, refreshOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(refreshUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(refreshOptions.method).toBe("POST");

    const [graphUrl, graphOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(graphUrl).toBe("https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta");
    expect((graphOptions.headers as { Authorization: string }).Authorization).toBe(
      "Bearer fresh-access-token",
    );
  });

  it("queues PDF files based on .pdf extension even without proper MIME type", async () => {
    mockOneDriveDb();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          value: [
            {
              id: "pdf-weird",
              name: "document.pdf",
              file: { mimeType: "application/octet-stream" }, // wrong MIME but .pdf extension
            },
          ],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=delta-x",
        }),
    });

    const response = await postSyncRun();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: 1 });

    const putItemCalls = mockDbSend.mock.calls.filter(([command]) => command instanceof PutCommand);
    expect(putItemCalls).toHaveLength(2); // 1 file record + 1 delta token
    const fileRecordPut = putItemCalls.find(
      ([cmd]) => (cmd as { input: { Item: { fileId?: string } } }).input.Item.fileId,
    );
    const [putCommand] = fileRecordPut as [
      { input: { Item: { fileId: string; filename: string } } },
    ];
    expect(putCommand.input.Item.fileId).toBe("pdf-weird");
    expect(putCommand.input.Item.filename).toBe("document.pdf");
  });

  it("returns 500 when Graph delta request fails with non-ok status", async () => {
    mockOneDriveDb();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
    });

    const response = await postSyncRun();

    expect(response.status).toBe(500);
  });

  it("returns 500 when Graph response has invalid shape (missing value array)", async () => {
    mockOneDriveDb();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          items: [], // wrong property name
          "@odata.deltaLink": "https://graph.microsoft.com/delta?token=x",
        }),
    });

    const response = await postSyncRun();

    expect(response.status).toBe(500);
  });
});

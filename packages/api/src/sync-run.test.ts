import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());
const mockSsmSend = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

vi.mock("./ssm.js", () => ({
  ssmClient: { send: mockSsmSend },
}));

vi.stubGlobal("fetch", mockFetch);

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

describe("POST /sync/run", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;
  const accessToken = "onedrive-access-token";
  const refreshToken = "onedrive-refresh-token";
  const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("ONEDRIVE_FOLDER", "OnyxBoox");
    vi.stubEnv("FILE_RECORDS_TABLE", "petroglyph-file-records-test");
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client-id");
    mockDbSend.mockReset();
    mockSsmSend.mockReset();
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

  function mockOneDriveSsm({
    deltaToken,
    tokenExpiry = futureExpiry,
    onedriveRefreshToken = refreshToken,
  }: {
    deltaToken?: string;
    tokenExpiry?: string;
    onedriveRefreshToken?: string;
  } = {}): void {
    mockSsmSend.mockImplementation((command: unknown) => {
      if (command instanceof GetParameterCommand) {
        if (command.input.Name === "/petroglyph/onedrive/access-token") {
          return Promise.resolve({
            Parameter: { Value: accessToken },
          });
        }

        if (command.input.Name === "/petroglyph/onedrive/token-expiry") {
          return Promise.resolve({
            Parameter: { Value: tokenExpiry },
          });
        }

        if (command.input.Name === "/petroglyph/onedrive/refresh-token") {
          return Promise.resolve({
            Parameter: { Value: onedriveRefreshToken },
          });
        }

        if (command.input.Name === "/petroglyph/onedrive/delta-token" && deltaToken !== undefined) {
          return Promise.resolve({
            Parameter: { Value: deltaToken },
          });
        }

        const error = new Error("Parameter not found");
        error.name = "ParameterNotFound";
        return Promise.reject(error);
      }

      if (command instanceof PutParameterCommand) {
        return Promise.resolve({});
      }

      return Promise.resolve({});
    });
  }

  it("queues PDF items on a first run when no delta token exists", async () => {
    mockOneDriveSsm();
    mockDbSend.mockResolvedValue({});
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
    expect(putItemCalls).toHaveLength(1);

    const [putCommand] = putItemCalls[0] as [
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
    expect(putCommand.input.TableName).toBe("petroglyph-file-records-test");
    expect(putCommand.input.Item.profileId).toBe("default");
    expect(putCommand.input.Item.fileId).toBe("pdf-1");
    expect(putCommand.input.Item.s3Key).toBe("");
    expect(putCommand.input.Item.filename).toBe("notes.pdf");
    expect(putCommand.input.Item.status).toBe("pending");
    expect(typeof putCommand.input.Item.createdAt).toBe("string");

    const putParameterCalls = mockSsmSend.mock.calls.filter(
      ([command]) => command instanceof PutParameterCommand,
    );
    expect(putParameterCalls).toHaveLength(1);
    const [putParameterCommand] = putParameterCalls[0] as [
      { input: { Name: string; Type: string; Value: string; Overwrite: boolean } },
    ];
    expect(putParameterCommand.input.Name).toBe("/petroglyph/onedrive/delta-token");
    expect(putParameterCommand.input.Type).toBe("SecureString");
    expect(putParameterCommand.input.Value).toBe("delta-token-1");
    expect(putParameterCommand.input.Overwrite).toBe(true);
  });

  it("continues an incremental sync from the stored delta token across pages", async () => {
    mockOneDriveSsm({ deltaToken: "delta-token-1" });
    mockDbSend.mockResolvedValue({});
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
    expect(putItemCalls).toHaveLength(2);

    const queuedFileIds = putItemCalls.map(
      ([command]) =>
        (
          command as {
            input: { Item: { fileId: string } };
          }
        ).input.Item.fileId,
    );
    expect(queuedFileIds).toEqual(["pdf-2", "pdf-3"]);

    const putParameterCalls = mockSsmSend.mock.calls.filter(
      ([command]) => command instanceof PutParameterCommand,
    );
    expect(putParameterCalls).toHaveLength(1);
    const [putParameterCommand] = putParameterCalls[0] as [{ input: { Value: string } }];
    expect(putParameterCommand.input.Value).toBe("delta-token-2");
  });

  it("returns queued=0 when the delta query contains no new PDF items", async () => {
    mockOneDriveSsm({ deltaToken: "delta-token-2" });
    mockDbSend.mockResolvedValue({});
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
    expect(putItemCalls).toHaveLength(0);

    const putParameterCalls = mockSsmSend.mock.calls.filter(
      ([command]) => command instanceof PutParameterCommand,
    );
    expect(putParameterCalls).toHaveLength(1);
    const [putParameterCommand] = putParameterCalls[0] as [
      { input: { Name: string; Type: string; Value: string } },
    ];
    expect(putParameterCommand.input.Name).toBe("/petroglyph/onedrive/delta-token");
    expect(putParameterCommand.input.Type).toBe("SecureString");
    expect(putParameterCommand.input.Value).toBe("delta-token-3");
  });

  it("refreshes an expiring access token before querying Graph", async () => {
    mockOneDriveSsm({
      tokenExpiry: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      onedriveRefreshToken: "onedrive-refresh-token",
    });
    mockDbSend.mockResolvedValue({});
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
});

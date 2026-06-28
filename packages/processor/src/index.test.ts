import type { PutObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockS3Send = vi.hoisted(() => vi.fn());
const mockDocSend = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, {
    S3Client: class {
      send = mockS3Send;
    },
  });
});

vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, {
    DynamoDBDocumentClient: {
      from: () => ({
        send: mockDocSend,
      }),
    },
  });
});

vi.stubGlobal("fetch", mockFetch);

import { handler } from "./index.js";

function makeEvent(body: unknown): SQSEvent {
  return {
    Records: [
      {
        messageId: "message-123",
        receiptHandle: "receipt-123",
        body: JSON.stringify(body),
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1",
          SenderId: "sender-123",
          ApproximateFirstReceiveTimestamp: "1",
        },
        messageAttributes: {},
        md5OfBody: "md5",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:eu-west-2:123456789012:petroglyph-ingest-staging",
        awsRegion: "eu-west-2",
      },
    ],
  };
}

interface MockTokenRecord {
  accessToken: string;
  refreshToken: string;
  expirySeconds: number;
}

function makeTokenRecord(overrides: Partial<MockTokenRecord> = {}): MockTokenRecord {
  return {
    accessToken: "existing-access-token",
    refreshToken: "existing-refresh-token",
    expirySeconds: Math.floor(Date.now() / 1000) + 60 * 60,
    ...overrides,
  };
}

function mockOneDriveParams(userId: string, record: MockTokenRecord): void {
  mockDocSend.mockImplementation((command: unknown) => {
    if (command instanceof GetCommand) {
      const key = command.input.Key as { tokenHash: string };
      if (key.tokenHash === userId) {
        return Promise.resolve({ Item: record });
      }
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
}

describe("processor handler", () => {
  beforeEach(() => {
    mockS3Send.mockReset();
    mockDocSend.mockReset();
    mockFetch.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.stubEnv("STAGED_PDFS_BUCKET", "petroglyph-staged-pdfs-staging");
    vi.stubEnv("STAGED_PDF_PREFIX", "handwritten");
    vi.stubEnv("FILE_RECORDS_TABLE", "petroglyph-file-records-staging");
    vi.stubEnv("REFRESH_TOKENS_TABLE", "petroglyph-refresh_tokens-staging");
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-microsoft-client-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("downloads the PDF, uploads it to S3, and writes a pending file record", async () => {
    mockOneDriveParams("default", makeTokenRecord());

    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "file-123",
            name: "notes.pdf",
            webUrl: "https://onedrive.example.com/file-123",
            parentReference: {
              driveId: "drive-123",
              path: "/drive/root:/OnyxBoox/Meeting Notes",
            },
            file: {
              mimeType: "application/pdf",
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
          },
        }),
      );

    const result = await handler(
      makeEvent({
        fileId: "file-123",
        profileId: "default",
        itemMetadata: {
          id: "file-123",
          odataType: "#Microsoft.Graph.DriveItem",
          name: "notes.pdf",
          webUrl: "https://onedrive.example.com/file-123",
          resource: "me/drive/items/file-123",
        },
      }),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://graph.microsoft.com/v1.0/me/drive/items/file-123",
      {
        headers: {
          Authorization: "Bearer existing-access-token",
        },
      },
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://graph.microsoft.com/v1.0/me/drive/items/file-123/content",
      {
        headers: {
          Authorization: "Bearer existing-access-token",
        },
      },
    );

    expect(mockS3Send).toHaveBeenCalledOnce();
    const [putObjectCommand] = mockS3Send.mock.calls[0] as [PutObjectCommand];
    expect(putObjectCommand.input.Bucket).toBe("petroglyph-staged-pdfs-staging");
    expect(putObjectCommand.input.Key).toBe("handwritten/OnyxBoox/Meeting Notes/notes.pdf");
    expect(putObjectCommand.input.ContentType).toBe("application/pdf");

    const allDocCalls = mockDocSend.mock.calls;
    const getCommands = allDocCalls.filter(([command]) => command instanceof GetCommand);
    const putCommands = allDocCalls.filter(([command]) => command instanceof PutCommand);

    expect(getCommands).toHaveLength(1);
    expect(putCommands).toHaveLength(1);

    const [getCommand] = getCommands[0] as [GetCommand];
    expect(getCommand.input.TableName).toBe("petroglyph-refresh_tokens-staging");
    expect(getCommand.input.Key).toEqual({ tokenHash: "default" });

    const [putCommand] = putCommands[0] as [PutCommand];
    expect(putCommand.input.TableName).toBe("petroglyph-file-records-staging");
    expect(putCommand.input.Item).toMatchObject({
      profileId: "default",
      fileId: "file-123",
      filename: "notes.pdf",
      s3Key: "handwritten/OnyxBoox/Meeting Notes/notes.pdf",
      status: "pending",
    });
    expect(typeof putCommand.input.Item?.["createdAt"]).toBe("string");
  });

  it("refreshes an expired access token before fetching and downloading the PDF", async () => {
    const expiredTime = Math.floor(Date.now() / 1000) - 60;
    mockOneDriveParams(
      "default",
      makeTokenRecord({
        accessToken: "expired-access-token",
        refreshToken: "stale-refresh-token",
        expirySeconds: expiredTime,
      }),
    );

    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "fresh-access-token",
            refresh_token: "fresh-refresh-token",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "file-123",
            name: "notes.pdf",
            parentReference: {
              driveId: "drive-123",
              path: "/drive/root:/Inbox",
            },
            file: {
              mimeType: "application/pdf",
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([5, 6, 7]), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
          },
        }),
      );

    const result = await handler(
      makeEvent({
        fileId: "file-123",
        profileId: "default",
        itemMetadata: {
          id: "file-123",
          odataType: "#Microsoft.Graph.DriveItem",
          name: "notes.pdf",
          resource: "me/drive/items/file-123",
        },
      }),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockFetch.mock.calls[0]).toEqual([
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "client_id=test-microsoft-client-id&grant_type=refresh_token&refresh_token=stale-refresh-token&scope=files.readwrite+offline_access",
      },
    ]);

    expect(mockFetch.mock.calls[1]).toEqual([
      "https://graph.microsoft.com/v1.0/me/drive/items/file-123",
      {
        headers: {
          Authorization: "Bearer fresh-access-token",
        },
      },
    ]);

    expect(mockFetch.mock.calls[2]).toEqual([
      "https://graph.microsoft.com/v1.0/me/drive/items/file-123/content",
      {
        headers: {
          Authorization: "Bearer fresh-access-token",
        },
      },
    ]);

    const updateCommands = mockDocSend.mock.calls.filter(
      ([command]) => command instanceof UpdateCommand,
    ) as [[UpdateCommand]];
    expect(updateCommands).toHaveLength(1);

    const [updateCommand] = updateCommands[0];
    expect(updateCommand.input.TableName).toBe("petroglyph-refresh_tokens-staging");
    expect(updateCommand.input.Key).toEqual({ tokenHash: "default" });
    expect(updateCommand.input.ExpressionAttributeValues).toMatchObject({
      ":accessToken": "fresh-access-token",
      ":refreshToken": "fresh-refresh-token",
    });
    expect(updateCommand.input.ExpressionAttributeValues?.[":expirySeconds"]).toEqual(
      expect.any(Number),
    );
  });

  it("skips non-PDF drive items without uploading or writing a file record", async () => {
    mockOneDriveParams("default", makeTokenRecord());

    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "file-123",
          name: "notes.txt",
          parentReference: {
            driveId: "drive-123",
            path: "/drive/root:/Inbox",
          },
          file: {
            mimeType: "text/plain",
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    const result = await handler(
      makeEvent({
        fileId: "file-123",
        profileId: "default",
        itemMetadata: {
          id: "file-123",
          odataType: "#Microsoft.Graph.DriveItem",
          name: "notes.txt",
          resource: "me/drive/items/file-123",
        },
      }),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockS3Send).not.toHaveBeenCalled();
    const putCommands = mockDocSend.mock.calls.filter(([command]) => command instanceof PutCommand);
    expect(putCommands).toHaveLength(0);
  });

  it("returns a batch item failure when PDF download fails", async () => {
    mockOneDriveParams("default", makeTokenRecord());

    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "file-123",
            name: "notes.pdf",
            parentReference: {
              driveId: "drive-123",
              path: "/drive/root:/Inbox",
            },
            file: {
              mimeType: "application/pdf",
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response("download failed", {
          status: 502,
          statusText: "Bad Gateway",
        }),
      );

    const result = await handler(
      makeEvent({
        fileId: "file-123",
        profileId: "default",
        itemMetadata: {
          id: "file-123",
          odataType: "#Microsoft.Graph.DriveItem",
          name: "notes.pdf",
          resource: "me/drive/items/file-123",
        },
      }),
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-123" }],
    });
    expect(mockS3Send).not.toHaveBeenCalled();
    const putCommands = mockDocSend.mock.calls.filter(([command]) => command instanceof PutCommand);
    expect(putCommands).toHaveLength(0);
  });
});

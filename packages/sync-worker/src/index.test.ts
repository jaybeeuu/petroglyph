import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDocSend = vi.hoisted(() => vi.fn());
const mockSqsSend = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

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
        eventSourceARN: "arn:aws:sqs:eu-west-2:123456789012:petroglyph-sync-jobs-test",
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

function mockTokenRecord({
  accessToken = "onedrive-access-token",
  refreshToken = "onedrive-refresh-token",
  expirySeconds = Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
}: Partial<MockTokenRecord> = {}): MockTokenRecord {
  return { accessToken, refreshToken, expirySeconds };
}

describe("sync-worker handler", () => {
  beforeEach(() => {
    vi.stubEnv("FILE_RECORDS_TABLE", "petroglyph-file-records-test");
    vi.stubEnv("DELTA_TOKENS_TABLE", "petroglyph-delta-tokens-test");
    vi.stubEnv("SYNC_JOBS_TABLE", "petroglyph-sync-jobs-test");
    vi.stubEnv("REFRESH_TOKENS_TABLE", "petroglyph-refresh-tokens-test");
    vi.stubEnv(
      "INGEST_QUEUE_URL",
      "https://sqs.eu-west-2.amazonaws.com/123456789/petroglyph-ingest-test",
    );
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client-id");
    mockDocSend.mockReset();
    mockSqsSend.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("processes a sync job and updates status to completed with file count", async () => {
    mockDocSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        const tableName = command.input.TableName;
        if (tableName === "petroglyph-refresh-tokens-test") {
          return Promise.resolve({ Item: mockTokenRecord() });
        }
        if (tableName === "petroglyph-delta-tokens-test") {
          return Promise.resolve({ Item: undefined });
        }
      }
      if (command instanceof PutCommand || command instanceof UpdateCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    mockSqsSend.mockResolvedValue({});

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
              id: "pdf-2",
              name: "meeting.pdf",
              file: { mimeType: "application/pdf" },
            },
          ],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=delta-token-1",
        }),
    });

    const event = makeEvent({
      jobId: "job-123",
      profileId: "profile-456",
      sourceFolderPath: "OnyxBoox",
      userId: "user-42",
    });

    const result = await handler(event);

    expect(result.batchItemFailures).toEqual([]);

    // Check that the job was claimed (status set to running) before work started
    const claimUpdate = mockDocSend.mock.calls.find(
      ([command]) =>
        command instanceof UpdateCommand &&
        command.input.TableName === "petroglyph-sync-jobs-test" &&
        command.input.ExpressionAttributeValues?.[":status"] === "running",
    );
    expect(claimUpdate).toBeDefined();

    // Check that file records were written
    const fileRecordPuts = mockDocSend.mock.calls.filter(
      ([command]) =>
        command instanceof PutCommand && command.input.TableName === "petroglyph-file-records-test",
    );
    expect(fileRecordPuts).toHaveLength(2);

    // Check that ingest messages were sent
    expect(mockSqsSend).toHaveBeenCalledTimes(2);

    // Check that job status was updated to completed
    const jobStatusUpdate = mockDocSend.mock.calls.find(
      ([command]) =>
        command instanceof UpdateCommand &&
        command.input.TableName === "petroglyph-sync-jobs-test" &&
        command.input.ExpressionAttributeValues?.[":status"] === "completed",
    );
    expect(jobStatusUpdate).toBeDefined();
    const [updateCommand] = jobStatusUpdate as [
      {
        input: {
          ExpressionAttributeValues: {
            ":status": string;
            ":fileCount": number;
          };
        };
      },
    ];
    expect(updateCommand.input.ExpressionAttributeValues[":fileCount"]).toBe(2);

    // Check that delta token was stored
    const deltaTokenPut = mockDocSend.mock.calls.find(
      ([command]) =>
        command instanceof PutCommand && command.input.TableName === "petroglyph-delta-tokens-test",
    );
    expect(deltaTokenPut).toBeDefined();
  });

  it("updates job status to failed when Graph API fails", async () => {
    mockDocSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        const tableName = command.input.TableName;
        if (tableName === "petroglyph-refresh-tokens-test") {
          return Promise.resolve({ Item: mockTokenRecord() });
        }
        if (tableName === "petroglyph-delta-tokens-test") {
          return Promise.resolve({ Item: undefined });
        }
      }
      if (command instanceof UpdateCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    const event = makeEvent({
      jobId: "job-456",
      profileId: "profile-789",
      sourceFolderPath: "OnyxBoox",
      userId: "user-42",
    });

    const result = await handler(event);

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0]?.itemIdentifier).toBe("message-123");

    // Check that job status was updated to failed
    const jobStatusUpdate = mockDocSend.mock.calls.find(
      ([command]) =>
        command instanceof UpdateCommand &&
        command.input.TableName === "petroglyph-sync-jobs-test" &&
        command.input.ExpressionAttributeValues?.[":status"] === "failed",
    );
    expect(jobStatusUpdate).toBeDefined();
    const [updateCommand] = jobStatusUpdate as [
      {
        input: {
          ExpressionAttributeValues: {
            ":status": string;
            ":errorMessage": string;
          };
        };
      },
    ];
    expect(updateCommand.input.ExpressionAttributeValues[":errorMessage"]).toContain(
      "Graph delta request failed",
    );
  });

  it("refreshes access token when it is about to expire", async () => {
    const expiringToken = mockTokenRecord({
      expirySeconds: Math.floor((Date.now() + 5 * 60 * 1000) / 1000),
    });

    mockDocSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        const tableName = command.input.TableName;
        if (tableName === "petroglyph-refresh-tokens-test") {
          return Promise.resolve({ Item: expiringToken });
        }
        if (tableName === "petroglyph-delta-tokens-test") {
          return Promise.resolve({ Item: undefined });
        }
      }
      if (command instanceof PutCommand || command instanceof UpdateCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    mockSqsSend.mockResolvedValue({});

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
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=delta-token-2",
          }),
      });

    const event = makeEvent({
      jobId: "job-789",
      profileId: "profile-123",
      sourceFolderPath: "OnyxBoox",
      userId: "user-42",
    });

    await handler(event);

    // Check that token refresh was called
    const refreshCall = mockFetch.mock.calls.find(
      ([url]) => url === "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
    expect(refreshCall).toBeDefined();

    // Check that Graph API was called with fresh token
    const graphCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("graph.microsoft.com"),
    );
    expect(graphCall).toBeDefined();
    const [, options] = graphCall as [string, RequestInit];
    expect((options.headers as { Authorization: string }).Authorization).toBe(
      "Bearer fresh-access-token",
    );
  });

  it("continues from existing delta token", async () => {
    mockDocSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        const tableName = command.input.TableName;
        if (tableName === "petroglyph-refresh-tokens-test") {
          return Promise.resolve({ Item: mockTokenRecord() });
        }
        if (tableName === "petroglyph-delta-tokens-test") {
          return Promise.resolve({ Item: { deltaToken: "existing-delta-token" } });
        }
      }
      if (command instanceof PutCommand || command instanceof UpdateCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    mockSqsSend.mockResolvedValue({});

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          value: [],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=new-delta-token",
        }),
    });

    const event = makeEvent({
      jobId: "job-999",
      profileId: "profile-456",
      sourceFolderPath: "OnyxBoox",
      userId: "user-42",
    });

    await handler(event);

    // Check that Graph API was called with existing delta token
    const graphCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("graph.microsoft.com"),
    );
    expect(graphCall).toBeDefined();
    const [url] = graphCall as [string];
    expect(url).toContain("token=existing-delta-token");
  });

  it("handles multiple pages of delta results", async () => {
    mockDocSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        const tableName = command.input.TableName;
        if (tableName === "petroglyph-refresh-tokens-test") {
          return Promise.resolve({ Item: mockTokenRecord() });
        }
        if (tableName === "petroglyph-delta-tokens-test") {
          return Promise.resolve({ Item: undefined });
        }
      }
      if (command instanceof PutCommand || command instanceof UpdateCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    mockSqsSend.mockResolvedValue({});

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            value: [
              {
                id: "pdf-1",
                name: "page1.pdf",
                file: { mimeType: "application/pdf" },
              },
            ],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?$skiptoken=page2",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            value: [
              {
                id: "pdf-2",
                name: "page2.pdf",
                file: { mimeType: "application/pdf" },
              },
            ],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=final-token",
          }),
      });

    const event = makeEvent({
      jobId: "job-multi-page",
      profileId: "profile-456",
      sourceFolderPath: "OnyxBoox",
      userId: "user-42",
    });

    await handler(event);

    // Check that both pages were fetched
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Check that ingest messages were sent for both files
    expect(mockSqsSend).toHaveBeenCalledTimes(2);

    // Check that job status shows correct file count
    const jobStatusUpdate = mockDocSend.mock.calls.find(
      ([command]) =>
        command instanceof UpdateCommand &&
        command.input.TableName === "petroglyph-sync-jobs-test" &&
        command.input.ExpressionAttributeValues?.[":status"] === "completed",
    );
    const [updateCommand] = jobStatusUpdate as [
      {
        input: {
          ExpressionAttributeValues: {
            ":fileCount": number;
          };
        };
      },
    ];
    expect(updateCommand.input.ExpressionAttributeValues[":fileCount"]).toBe(2);
  });

  it("claims the job by setting status to running before starting work", async () => {
    mockDocSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        const tableName = command.input.TableName;
        if (tableName === "petroglyph-refresh-tokens-test") {
          return Promise.resolve({ Item: mockTokenRecord() });
        }
        if (tableName === "petroglyph-delta-tokens-test") {
          return Promise.resolve({ Item: undefined });
        }
      }
      if (command instanceof PutCommand || command instanceof UpdateCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    mockSqsSend.mockResolvedValue({});

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          value: [],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=delta-token-3",
        }),
    });

    const event = makeEvent({
      jobId: "job-claim",
      profileId: "profile-claim",
      sourceFolderPath: "OnyxBoox",
      userId: "user-42",
    });

    await handler(event);

    const claimUpdate = mockDocSend.mock.calls.find(
      ([command]) =>
        command instanceof UpdateCommand &&
        command.input.TableName === "petroglyph-sync-jobs-test" &&
        command.input.ExpressionAttributeValues?.[":status"] === "running",
    );
    expect(claimUpdate).toBeDefined();
    expect(claimUpdate?.[0]).toBe(mockDocSend.mock.calls[0]?.[0]);

    const [claimCommand] = claimUpdate as [
      {
        input: {
          UpdateExpression: string;
          ConditionExpression: string;
          ExpressionAttributeValues: {
            ":status": string;
            ":queued": string;
            ":failed": string;
          };
        };
      },
    ];
    expect(claimCommand.input.UpdateExpression).toContain(":status");
    expect(claimCommand.input.ConditionExpression).toContain(":queued");
    expect(claimCommand.input.ExpressionAttributeValues[":status"]).toBe("running");
  });

  it("skips a job whose record is already running or completed", async () => {
    // Claiming fails with a conditional-check violation, as it would when the
    // record is already running/completed (duplicate delivery).
    mockDocSend.mockImplementation((command: unknown) => {
      if (
        command instanceof UpdateCommand &&
        command.input.TableName === "petroglyph-sync-jobs-test"
      ) {
        const error = new Error("ConditionalCheckFailedException");
        error.name = "ConditionalCheckFailedException";
        return Promise.reject(error);
      }
      return Promise.resolve({});
    });

    mockFetch.mockImplementation(() => {
      throw new Error("Graph should not be called for a duplicate job");
    });

    const event = makeEvent({
      jobId: "job-duplicate",
      profileId: "profile-duplicate",
      sourceFolderPath: "OnyxBoox",
      userId: "user-42",
    });

    const result = await handler(event);

    // The duplicate is consumed without reporting a batch failure and without
    // any processing side effects.
    expect(result.batchItemFailures).toEqual([]);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("retries a job whose record is marked failed", async () => {
    mockDocSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        const tableName = command.input.TableName;
        if (tableName === "petroglyph-refresh-tokens-test") {
          return Promise.resolve({ Item: mockTokenRecord() });
        }
        if (tableName === "petroglyph-delta-tokens-test") {
          return Promise.resolve({ Item: undefined });
        }
      }
      if (command instanceof PutCommand || command instanceof UpdateCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    mockSqsSend.mockResolvedValue({});

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          value: [],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/drive/root:/OnyxBoox:/delta?token=delta-token-4",
        }),
    });

    const event = makeEvent({
      jobId: "job-retry",
      profileId: "profile-retry",
      sourceFolderPath: "OnyxBoox",
      userId: "user-42",
    });

    const result = await handler(event);

    // The claim permits jobs already marked failed (SQS redrive) to run again.
    expect(result.batchItemFailures).toEqual([]);
    const completionUpdate = mockDocSend.mock.calls.find(
      ([command]) =>
        command instanceof UpdateCommand &&
        command.input.TableName === "petroglyph-sync-jobs-test" &&
        command.input.ExpressionAttributeValues?.[":status"] === "completed",
    );
    expect(completionUpdate).toBeDefined();
  });
});

import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const mockSqsSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-sqs", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, {
    SQSClient: class {
      send = mockSqsSend;
    },
  });
});

import { flushPendingNotificationWork, handler } from "./index.js";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;

  const promise = new Promise<Value>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function makeRequestContext(
  method: string,
): Pick<APIGatewayProxyEventV2, "requestContext">["requestContext"] {
  return {
    accountId: "test-account",
    apiId: "test-api",
    domainName: "example.com",
    domainPrefix: "example",
    http: {
      method,
      path: "/ingest",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "vitest",
    },
    requestId: "request-123",
    routeKey: "$default",
    stage: "$default",
    time: "11/Apr/2026:09:00:00 +0000",
    timeEpoch: 1_744_363_200_000,
  };
}

function makeNotificationBody(clientState = "expected-secret"): string {
  return JSON.stringify({
    value: [
      {
        subscriptionId: "subscription-123",
        clientState,
        changeType: "updated",
        resource: "drives/drive-123/items/file-123",
        resourceData: {
          id: "file-123",
          "@odata.type": "#Microsoft.Graph.DriveItem",
          name: "notes.pdf",
          webUrl: "https://onedrive.example.com/file-123",
          parentReference: {
            driveId: "drive-123",
            path: "/drive/root:/Inbox",
          },
        },
      },
    ],
  });
}

type ConsoleErrorSpy = MockInstance<(message: string, context: { [key: string]: unknown }) => void>;

describe("ingest-onedrive handler", () => {
  let consoleErrorSpy: ConsoleErrorSpy;

  beforeEach(() => {
    vi.stubEnv("INGEST_QUEUE_URL", "https://sqs.example.com/queue");
    mockSqsSend.mockReset();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    mockSqsSend.mockImplementation((command: unknown) => {
      if (command instanceof SendMessageCommand) {
        return Promise.resolve({ MessageId: "message-123" });
      }

      return Promise.resolve({});
    });
  });

  afterEach(async () => {
    await flushPendingNotificationWork();
    consoleErrorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("returns the validation token as plain text on POST handshake requests", async () => {
    const result = await handler({
      requestContext: makeRequestContext("POST"),
      queryStringParameters: {
        validationToken: "hello-from-graph",
      },
    });

    expect(result).toEqual({
      statusCode: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: "hello-from-graph",
    });
  });

  it("returns 401 when the notification clientState is blank after trimming", async () => {
    const result = await handler({
      body: makeNotificationBody("   "),
      requestContext: makeRequestContext("POST"),
    });

    expect(result).toMatchObject({
      statusCode: 401,
      body: JSON.stringify({ error: "Invalid clientState" }),
    });
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it("returns 400 when the notification payload is missing required fields", async () => {
    const result = await handler({
      body: JSON.stringify({
        value: [
          {
            subscriptionId: "subscription-123",
            clientState: "expected-secret",
            changeType: "updated",
            resource: "drives/drive-123/items/file-123",
            resourceData: {
              "@odata.type": "#Microsoft.Graph.DriveItem",
            },
          },
        ],
      }),
      requestContext: makeRequestContext("POST"),
    });

    expect(result).toMatchObject({
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid notification payload" }),
    });
    expect(mockSqsSend).not.toHaveBeenCalled();

    const [rejectionMessage, rejectionContext] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(rejectionMessage).toContain("schema mismatch");
    expect(rejectionContext).toMatchObject({
      reason: "schema-mismatch",
      issues: [{ path: "value.0.resourceData.id" }],
    });
  });

  it("returns 400 when the notification body is not valid JSON", async () => {
    const result = await handler({
      body: "{not-json",
      requestContext: makeRequestContext("POST"),
    });

    expect(result).toMatchObject({
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid notification payload" }),
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid JSON"),
      expect.objectContaining({ reason: "invalid-json" }),
    );
  });

  it("returns 400 and logs an empty body distinctly from malformed JSON", async () => {
    const result = await handler({
      body: "",
      requestContext: makeRequestContext("POST"),
    });

    expect(result).toMatchObject({
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid notification payload" }),
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("empty body"),
      expect.objectContaining({ reason: "empty-body", byteLength: 0 }),
    );
  });

  it("logs request details for a rejected notification", async () => {
    const body = JSON.stringify({ value: [] });

    await handler({
      body,
      headers: { "content-type": "application/json" },
      isBase64Encoded: true,
      requestContext: makeRequestContext("POST"),
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("schema mismatch"),
      expect.objectContaining({
        contentType: "application/json",
        isBase64Encoded: true,
        byteLength: Buffer.byteLength(body, "utf8"),
      }),
    );
  });

  it("does not log the raw notification body on rejection", async () => {
    const body = JSON.stringify({ value: "sensitive-content" });

    await handler({
      body,
      requestContext: makeRequestContext("POST"),
    });

    const [, loggedContext] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(JSON.stringify(loggedContext)).not.toContain("sensitive-content");
  });

  it("accepts non-blank clientState values from existing subscriptions", async () => {
    const result = await handler({
      body: makeNotificationBody("user-123"),
      requestContext: makeRequestContext("POST"),
    });

    expect(result).toMatchObject({
      statusCode: 200,
    });

    await flushPendingNotificationWork();
    expect(mockSqsSend).toHaveBeenCalledOnce();
  });

  it("returns 200 without waiting for the SQS enqueue to finish", async () => {
    const sqsDeferred = createDeferred<{ MessageId: string }>();
    mockSqsSend.mockImplementation((command: unknown) => {
      if (command instanceof SendMessageCommand) {
        return sqsDeferred.promise;
      }

      return Promise.resolve({});
    });

    const result = await handler({
      body: makeNotificationBody(),
      requestContext: makeRequestContext("POST"),
    });

    expect(result).toMatchObject({
      statusCode: 200,
    });

    try {
      await vi.waitFor(() => {
        expect(mockSqsSend).toHaveBeenCalledOnce();
      });
    } finally {
      sqsDeferred.resolve({ MessageId: "message-123" });
    }

    await flushPendingNotificationWork();
  });

  it("enqueues file metadata for valid notifications", async () => {
    const result = await handler({
      body: makeNotificationBody(),
      requestContext: makeRequestContext("POST"),
    });

    expect(result).toMatchObject({
      statusCode: 200,
    });

    await flushPendingNotificationWork();
    expect(mockSqsSend).toHaveBeenCalledOnce();

    const [command] = mockSqsSend.mock.calls[0] as [SendMessageCommand];
    expect(command.input.QueueUrl).toBe("https://sqs.example.com/queue");
    expect(command.input.MessageBody).toBe(
      JSON.stringify({
        fileId: "file-123",
        profileId: "default",
        itemMetadata: {
          id: "file-123",
          odataType: "#Microsoft.Graph.DriveItem",
          name: "notes.pdf",
          webUrl: "https://onedrive.example.com/file-123",
          resource: "drives/drive-123/items/file-123",
          parentReference: {
            driveId: "drive-123",
            path: "/drive/root:/Inbox",
          },
        },
      }),
    );
  });
});

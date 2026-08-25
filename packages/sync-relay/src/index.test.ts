import type { AttributeValue, DynamoDBStreamEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSqsSend = vi.hoisted(() => vi.fn());
const mockDocSend = vi.hoisted(() => vi.fn());

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

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "./index.js";

function stringAttribute(value: string): AttributeValue {
  return { S: value };
}

function numberAttribute(value: number): AttributeValue {
  return { N: String(value) };
}

function jobRecord(
  overrides: {
    eventName?: "INSERT" | "MODIFY" | "REMOVE";
    sequenceNumber?: string;
    jobId?: string;
    profileId?: string;
    sourceFolderPath?: string;
    userId?: string;
    status?: string;
    retryCount?: number;
    userIdentity?: { principalId: string; type: string } | null;
  } = {},
): DynamoDBStreamEvent["Records"][number] {
  const {
    eventName = "INSERT",
    sequenceNumber = "100",
    jobId = "job-123",
    profileId = "profile-456",
    sourceFolderPath = "OnyxBoox",
    userId = "user-42",
    status = "queued",
    retryCount = 0,
    userIdentity = { principalId: "dynamodb.amazonaws.com", type: "Service" },
  } = overrides;

  return {
    eventID: "event-1",
    eventName,
    eventVersion: "1.1",
    eventSource: "aws:dynamodb",
    awsRegion: "eu-west-2",
    ...(userIdentity === null ? {} : { userIdentity }),
    dynamodb: {
      ApproximateCreationDateTime: 1,
      Keys: { jobId: stringAttribute(jobId) },
      NewImage: {
        jobId: stringAttribute(jobId),
        profileId: stringAttribute(profileId),
        sourceFolderPath: stringAttribute(sourceFolderPath),
        userId: stringAttribute(userId),
        status: stringAttribute(status),
        retryCount: numberAttribute(retryCount),
      },
      SequenceNumber: sequenceNumber,
      SizeBytes: 26,
      StreamViewType: "NEW_IMAGE",
    },
    eventSourceARN:
      "arn:aws:dynamodb:eu-west-2:123456789012:table/petroglyph-sync-jobs-test/stream/2026-08-18T00:00:00.000",
  };
}

function makeEvent(records: DynamoDBStreamEvent["Records"]): DynamoDBStreamEvent {
  return { Records: records };
}

describe("sync-relay handler", () => {
  beforeEach(() => {
    vi.stubEnv(
      "SYNC_JOB_QUEUE_URL",
      "https://sqs.eu-west-2.amazonaws.com/123456789/petroglyph-sync-jobs-test",
    );
    vi.stubEnv("SYNC_JOBS_TABLE", "petroglyph-sync-jobs-test");
    mockSqsSend.mockReset();
    mockDocSend.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("relays an INSERT record to the sync-jobs queue with the job payload", async () => {
    mockSqsSend.mockResolvedValue({});

    const result = await handler(
      makeEvent([jobRecord({ jobId: "job-123", sourceFolderPath: "OnyxBoox" })]),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(mockSqsSend).toHaveBeenCalledTimes(1);

    const sqsCall = mockSqsSend.mock.calls[0];
    expect(sqsCall).toBeDefined();
    const [sqsCommand] = sqsCall as [{ input: { QueueUrl: string; MessageBody: string } }];
    expect(sqsCommand.input.QueueUrl).toBe(
      "https://sqs.eu-west-2.amazonaws.com/123456789/petroglyph-sync-jobs-test",
    );

    const message = JSON.parse(sqsCommand.input.MessageBody) as {
      jobId: string;
      profileId: string;
      sourceFolderPath: string;
      userId: string;
    };
    expect(message).toEqual({
      jobId: "job-123",
      profileId: "profile-456",
      sourceFolderPath: "OnyxBoox",
      userId: "user-42",
    });
  });

  it("ignores MODIFY records and REMOVE records of completed jobs", async () => {
    mockSqsSend.mockResolvedValue({});
    mockDocSend.mockResolvedValue({});

    const result = await handler(
      makeEvent([
        jobRecord({ eventName: "MODIFY", sequenceNumber: "101" }),
        jobRecord({ eventName: "REMOVE", status: "completed", sequenceNumber: "102" }),
      ]),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(mockDocSend).not.toHaveBeenCalled();
  });

  it("skips INSERT records that are missing required fields", async () => {
    mockSqsSend.mockResolvedValue({});

    const record = jobRecord();
    delete record.dynamodb?.NewImage?.["sourceFolderPath"];

    const result = await handler(makeEvent([record]));

    expect(result.batchItemFailures).toEqual([]);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it("skips INSERT records whose status is not queued", async () => {
    mockSqsSend.mockResolvedValue({});

    const result = await handler(
      makeEvent([jobRecord({ status: "running", sequenceNumber: "103" })]),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it("reports failures by sequence number when the queue send fails", async () => {
    mockSqsSend.mockRejectedValue(new Error("SQS send failed"));

    const result = await handler(makeEvent([jobRecord({ sequenceNumber: "200" })]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "200" }]);
  });

  it("relays the remaining records when one record in the batch fails", async () => {
    mockSqsSend.mockRejectedValueOnce(new Error("SQS send failed")).mockResolvedValueOnce({});

    const result = await handler(
      makeEvent([
        jobRecord({ sequenceNumber: "300" }),
        jobRecord({ sequenceNumber: "301", jobId: "job-other" }),
      ]),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "300" }]);
    expect(mockSqsSend).toHaveBeenCalledTimes(2);
  });

  it("re-creates a job whose queued record was removed by TTL", async () => {
    mockDocSend.mockResolvedValue({});

    const before = Math.floor(Date.now() / 1000);
    const result = await handler(
      makeEvent([jobRecord({ eventName: "REMOVE", sequenceNumber: "400" })]),
    );
    const after = Math.floor(Date.now() / 1000);

    expect(result.batchItemFailures).toEqual([]);
    // Re-creation is a DynamoDB put, not a queue send; the new INSERT stream
    // record re-dispatches through the existing relay path.
    expect(mockSqsSend).not.toHaveBeenCalled();

    const putCalls = mockDocSend.mock.calls.filter(([command]) => command instanceof PutCommand);
    expect(putCalls).toHaveLength(1);
    const [putCallArgs] = putCalls;
    const [putCommand] = putCallArgs as unknown as [
      { input: { TableName: string; Item: { expiresAt: number; retryCount: number } } },
    ];
    expect(putCommand.input.TableName).toBe("petroglyph-sync-jobs-test");
    expect(putCommand.input.Item).toMatchObject({
      jobId: "job-123",
      profileId: "profile-456",
      sourceFolderPath: "OnyxBoox",
      userId: "user-42",
      status: "queued",
      retryCount: 1,
    });
    // The re-created record gets a fresh 5-minute TTL window.
    expect(putCommand.input.Item.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60 - 1);
    expect(putCommand.input.Item.expiresAt).toBeLessThanOrEqual(after + 5 * 60 + 1);
  });

  it("ignores TTL removals of running, completed, or failed records", async () => {
    mockDocSend.mockResolvedValue({});

    const result = await handler(
      makeEvent([
        jobRecord({ eventName: "REMOVE", status: "running", sequenceNumber: "401" }),
        jobRecord({ eventName: "REMOVE", status: "completed", sequenceNumber: "402" }),
        jobRecord({ eventName: "REMOVE", status: "failed", sequenceNumber: "403" }),
      ]),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(mockDocSend).not.toHaveBeenCalled();
  });

  it("ignores REMOVE records that are not TTL deletions", async () => {
    mockDocSend.mockResolvedValue({});

    const result = await handler(
      makeEvent([
        jobRecord({
          eventName: "REMOVE",
          userIdentity: null,
          sequenceNumber: "404",
        }),
      ]),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(mockDocSend).not.toHaveBeenCalled();
  });

  it("drops a job permanently once its retryCount reaches the cap", async () => {
    mockDocSend.mockResolvedValue({});

    const result = await handler(
      makeEvent([jobRecord({ eventName: "REMOVE", retryCount: 5, sequenceNumber: "405" })]),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(mockDocSend).not.toHaveBeenCalled();
  });

  it("re-creates a job at retryCount 4 as retryCount 5", async () => {
    mockDocSend.mockResolvedValue({});

    const result = await handler(
      makeEvent([jobRecord({ eventName: "REMOVE", retryCount: 4, sequenceNumber: "406" })]),
    );

    expect(result.batchItemFailures).toEqual([]);

    const putCalls = mockDocSend.mock.calls.filter(([command]) => command instanceof PutCommand);
    expect(putCalls).toHaveLength(1);
    const [putCallArgs] = putCalls;
    const [putCommand] = putCallArgs as unknown as [{ input: { Item: { retryCount: number } } }];
    expect(putCommand.input.Item.retryCount).toBe(5);
  });

  it("skips TTL removals that are missing required fields", async () => {
    mockDocSend.mockResolvedValue({});

    const record = jobRecord({ eventName: "REMOVE", sequenceNumber: "407" });
    delete record.dynamodb?.NewImage?.["sourceFolderPath"];

    const result = await handler(makeEvent([record]));

    expect(result.batchItemFailures).toEqual([]);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(mockDocSend).not.toHaveBeenCalled();
  });
});

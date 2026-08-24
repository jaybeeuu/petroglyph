import type { AttributeValue, DynamoDBStreamEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSqsSend = vi.hoisted(() => vi.fn());

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

import { handler } from "./index.js";

function stringAttribute(value: string): AttributeValue {
  return { S: value };
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
  } = overrides;

  return {
    eventID: "event-1",
    eventName,
    eventVersion: "1.1",
    eventSource: "aws:dynamodb",
    awsRegion: "eu-west-2",
    dynamodb: {
      ApproximateCreationDateTime: 1,
      Keys: { jobId: stringAttribute(jobId) },
      NewImage: {
        jobId: stringAttribute(jobId),
        profileId: stringAttribute(profileId),
        sourceFolderPath: stringAttribute(sourceFolderPath),
        userId: stringAttribute(userId),
        status: stringAttribute(status),
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
    mockSqsSend.mockReset();
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

  it("ignores MODIFY and REMOVE records", async () => {
    mockSqsSend.mockResolvedValue({});

    const result = await handler(
      makeEvent([
        jobRecord({ eventName: "MODIFY", sequenceNumber: "101" }),
        jobRecord({ eventName: "REMOVE", sequenceNumber: "102" }),
      ]),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(mockSqsSend).not.toHaveBeenCalled();
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
});

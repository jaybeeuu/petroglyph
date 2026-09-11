import { describe, expect, it, vi } from "vitest";
import type { SQSEvent } from "aws-lambda";
import type { DeltaSyncResult } from "./adapter/sync.js";
import { createAdapterHandler } from "./lambda.js";

function sqsEvent(bodies: string[]): SQSEvent {
  return {
    Records: bodies.map((body, index) => ({
      messageId: `msg-${index}`,
      receiptHandle: `handle-${index}`,
      body,
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "0",
        SenderId: "test",
        ApproximateFirstReceiveTimestamp: "0",
      },
      messageAttributes: {},
      md5OfBody: "abc",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:eu-west-2:123456789012:delta-trigger",
      awsRegion: "eu-west-2",
    })),
  };
}

const trigger = { userId: "u1", provider: "onedrive" };
const completed: DeltaSyncResult = { outcome: "completed", landed: 1, deleted: 0, skipped: 0 };
const failed: DeltaSyncResult = { outcome: "failed", landed: 0, deleted: 0, skipped: 0 };

describe("adapter lambda handler (delta-trigger SQS)", () => {
  it("runs the delta sync for each valid trigger and reports no failures", async () => {
    const runDelta = vi.fn().mockResolvedValue(completed);
    const handler = createAdapterHandler({ runDelta });

    const response = await handler(sqsEvent([JSON.stringify(trigger), JSON.stringify(trigger)]));

    expect(runDelta).toHaveBeenCalledTimes(2);
    expect(runDelta).toHaveBeenCalledWith(trigger);
    expect(response.batchItemFailures).toEqual([]);
  });

  it("fails the message when the walk fails so SQS redelivers it", async () => {
    const runDelta = vi.fn().mockResolvedValue(failed);
    const handler = createAdapterHandler({ runDelta });

    const response = await handler(sqsEvent([JSON.stringify(trigger)]));

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });

  it("fails the message when the run throws (transient error) and keeps the batch going", async () => {
    const runDelta = vi
      .fn()
      .mockRejectedValueOnce(new Error("graph 500"))
      .mockResolvedValueOnce(completed);
    const handler = createAdapterHandler({ runDelta });

    const response = await handler(
      sqsEvent([JSON.stringify(trigger), JSON.stringify({ userId: "u2", provider: "onedrive" })]),
    );

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });

  it("skips a malformed trigger with a loud log and never retries the poison message", async () => {
    const runDelta = vi.fn().mockResolvedValue(completed);
    const logged: string[] = [];
    const handler = createAdapterHandler({ runDelta, log: (message) => logged.push(message) });

    const response = await handler(
      sqsEvent(["not-json", JSON.stringify({ userId: "u1" }), JSON.stringify(trigger)]),
    );

    expect(runDelta).toHaveBeenCalledTimes(1);
    expect(response.batchItemFailures).toEqual([]);
    // two poison rows (unparseable JSON + missing provider) both logged loudly
    expect(logged).toHaveLength(2);
    expect(logged.every((entry) => entry.includes("invalid delta trigger"))).toBe(true);
  });
});

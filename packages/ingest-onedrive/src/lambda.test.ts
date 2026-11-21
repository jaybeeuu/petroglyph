import { describe, expect, it, vi } from "vitest";
import type { SQSEvent } from "aws-lambda";
import type { DeltaSyncResult } from "./adapter/sync.js";
import type { Logger } from "./log.js";
import { createAdapterHandler } from "./lambda.js";

/** The three levels as separate spies, so a test asserts the level, not just the text. */
function createLoggerStub(): Logger & {
  info: ReturnType<typeof vi.fn<(message: string) => void>>;
  warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  error: ReturnType<typeof vi.fn<(message: string) => void>>;
} {
  return {
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  };
}

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
const completed: DeltaSyncResult = {
  outcome: "completed",
  landed: 1,
  deleted: 0,
  skipped: 0,
  pagesCompleted: 1,
  pagesRemaining: 0,
};
const failed: DeltaSyncResult = {
  outcome: "failed",
  landed: 0,
  deleted: 0,
  skipped: 0,
  pagesCompleted: 0,
  pagesRemaining: null,
};
// The page budget ran out, so the walk stopped at a page boundary with pages
// left to fetch: completed, but not finished.
const deferred: DeltaSyncResult = {
  outcome: "completed",
  landed: 1,
  deleted: 0,
  skipped: 0,
  pagesCompleted: 1,
  pagesRemaining: null,
};

describe("adapter lambda handler (delta-trigger SQS)", () => {
  it("logs a walk that reached the terminal token at INFO, with pages and items, and no ERROR", async () => {
    const runDelta = vi.fn().mockResolvedValue(completed);
    const log = createLoggerStub();
    const handler = createAdapterHandler({ runDelta, log });

    const response = await handler(sqsEvent([JSON.stringify(trigger), JSON.stringify(trigger)]));

    expect(runDelta).toHaveBeenCalledTimes(2);
    expect(runDelta).toHaveBeenCalledWith(trigger);
    expect(response.batchItemFailures).toEqual([]);
    // A walk that reached the terminal change token reports a real remaining
    // count (none) and what it landed, so a healthy run is one INFO line.
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      "[adapter] delta run for u1/onedrive completed: 1 page(s) completed, 0 remaining, 1 landed, 0 deleted, 0 skipped",
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a deferred walk at WARN, naming the pages completed and that pages remain", async () => {
    const runDelta = vi.fn().mockResolvedValue(deferred);
    const log = createLoggerStub();
    const handler = createAdapterHandler({ runDelta, log });

    const response = await handler(sqsEvent([JSON.stringify(trigger)]));

    expect(response.batchItemFailures).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      "[adapter] delta run for u1/onedrive completed: 1 page(s) completed, more remain, 1 landed, 0 deleted, 0 skipped",
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs a failed walk at ERROR with its pages and items, so a stalled catch-up stays loud", async () => {
    const runDelta = vi.fn().mockResolvedValue({ ...failed, pagesCompleted: 2 });
    const log = createLoggerStub();
    const handler = createAdapterHandler({ runDelta, log });

    const response = await handler(sqsEvent([JSON.stringify(trigger)]));

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(log.error).toHaveBeenCalledWith(
      "[adapter] delta run for u1/onedrive failed: 2 page(s) completed, more remain, 0 landed, 0 deleted, 0 skipped",
    );
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("fails the message when the walk fails so SQS redelivers it", async () => {
    const runDelta = vi.fn().mockResolvedValue(failed);
    const handler = createAdapterHandler({ runDelta });

    const response = await handler(sqsEvent([JSON.stringify(trigger)]));

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });

  it("fails the message and logs ERROR when the run throws (transient error), keeping the batch going", async () => {
    const runDelta = vi
      .fn()
      .mockRejectedValueOnce(new Error("graph 500"))
      .mockResolvedValueOnce(completed);
    const log = createLoggerStub();
    const handler = createAdapterHandler({ runDelta, log });

    const response = await handler(
      sqsEvent([JSON.stringify(trigger), JSON.stringify({ userId: "u2", provider: "onedrive" })]),
    );

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    // The loop kept going: the record after the throw was still handed to the run.
    expect(runDelta).toHaveBeenCalledWith({ userId: "u2", provider: "onedrive" });
    expect(log.error).toHaveBeenCalledWith("[adapter] delta run failed: Error: graph 500");
  });

  it("skips a malformed trigger with a loud log and never retries the poison message", async () => {
    const runDelta = vi.fn().mockResolvedValue(completed);
    const log = createLoggerStub();
    const handler = createAdapterHandler({ runDelta, log });

    const response = await handler(
      sqsEvent(["not-json", JSON.stringify({ userId: "u1" }), JSON.stringify(trigger)]),
    );

    expect(runDelta).toHaveBeenCalledTimes(1);
    expect(response.batchItemFailures).toEqual([]);
    // Two poison rows (unparseable JSON + missing provider) both logged loudly,
    // and never at a level an operator filters out.
    const poison = log.error.mock.calls.filter(([entry]) =>
      entry.includes("invalid delta trigger"),
    );
    expect(poison).toHaveLength(2);
  });
});

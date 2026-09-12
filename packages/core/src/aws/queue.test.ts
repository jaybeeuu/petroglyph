import { describe, expect, it, vi } from "vitest";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { createSqsQueue } from "./queue.js";

interface StagingMessage {
  s3Key: string;
  profileId: string;
}

describe("createSqsQueue", () => {
  it("encodes messages via the injected encoder and sends them to the queue URL", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as SQSClient;
    const queue = createSqsQueue<StagingMessage>({
      client,
      queueUrl: "https://sqs.eu-west-2.amazonaws.com/123456789012/staging.fifo",
      encode: (message) => JSON.stringify(message),
    });

    await queue.send({ s3Key: "staging/v1/p1/a/b.pdf", profileId: "p1" });

    expect(send).toHaveBeenCalledTimes(1);
    const command = (send.mock.calls[0] as [{ input: { [key: string]: unknown } }])[0];
    expect(command.input).toMatchObject({
      QueueUrl: "https://sqs.eu-west-2.amazonaws.com/123456789012/staging.fifo",
      MessageBody: '{"s3Key":"staging/v1/p1/a/b.pdf","profileId":"p1"}',
    });
    expect(command.input["MessageGroupId"]).toBeUndefined();
  });

  it("passes the message group id through when provided (FIFO ordering key)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as SQSClient;
    const queue = createSqsQueue<StagingMessage>({
      client,
      queueUrl: "https://sqs.eu-west-2.amazonaws.com/123456789012/staging.fifo",
      encode: (message) => JSON.stringify(message),
    });

    await queue.send({ s3Key: "staging/v1/p1/a/b.pdf", profileId: "p1" }, { messageGroupId: "p1" });

    const command = (send.mock.calls[0] as [{ input: { [key: string]: unknown } }])[0];
    expect(command.input["MessageGroupId"]).toBe("p1");
  });

  it("propagates send failures to the caller", async () => {
    const send = vi.fn().mockRejectedValue(new Error("SQS send failed"));
    const client = { send } as unknown as SQSClient;
    const queue = createSqsQueue<StagingMessage>({
      client,
      queueUrl: "https://sqs.eu-west-2.amazonaws.com/123456789012/staging.fifo",
      encode: (message) => JSON.stringify(message),
    });

    await expect(queue.send({ s3Key: "staging/v1/p1/a/b.pdf", profileId: "p1" })).rejects.toThrow(
      "SQS send failed",
    );
  });
});

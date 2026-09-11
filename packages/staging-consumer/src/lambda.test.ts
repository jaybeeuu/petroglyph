import { describe, expect, it, vi } from "vitest";
import type { DynamoDBStreamEvent } from "aws-lambda";
import type { Queue } from "@petroglyph/core";
import type { CloudEvent } from "@petroglyph/events";
import { fileStagedEvent } from "@petroglyph/staging-contracts";
import { createForwarderHandler } from "./lambda.js";

const stagedDoc = fileStagedEvent.buildDocument({
  id: "emission-1",
  source: "onedrive://profiles/p1",
  subject: "files/item-1",
  data: {
    profileId: "p1",
    source: "onedrive",
    changeType: "created",
    itemId: "item-1",
    name: "a.pdf",
    relativePath: "notes",
    s3Key: "staging/v1/p1/notes/a.pdf",
    mimeType: "application/pdf",
  },
});

function streamEvent(): DynamoDBStreamEvent {
  return {
    Records: [
      {
        eventID: "shardId-000000000000:00000000000000000001",
        eventName: "INSERT",
        eventSource: "aws:dynamodb",
        eventVersion: "1.1",
        awsRegion: "eu-west-2",
        dynamodb: {
          SequenceNumber: "100001",
          SizeBytes: 400,
          StreamViewType: "NEW_IMAGE",
          NewImage: { doc: { S: JSON.stringify(stagedDoc) } },
        },
      },
      {
        eventID: "shardId-000000000000:00000000000000000002",
        eventName: "INSERT",
        eventSource: "aws:dynamodb",
        eventVersion: "1.1",
        awsRegion: "eu-west-2",
        dynamodb: {
          SequenceNumber: "100002",
          SizeBytes: 400,
          StreamViewType: "NEW_IMAGE",
          NewImage: { doc: { S: "not-json{" } },
        },
      },
    ],
  };
}

function queueSpy(): Queue<CloudEvent<unknown>> & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async () => undefined),
  };
}

describe("forwarder lambda handler", () => {
  it("forwards every sendable row and never lists skipped malformed rows as failures", async () => {
    const queue = queueSpy();
    const handler = createForwarderHandler({ queue });

    const response = await handler(streamEvent());

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(response.batchItemFailures).toEqual([]);
  });

  it("marks a row whose send throws as a batch failure (Streams redelivers it), keeping others", async () => {
    const queue = queueSpy();
    queue.send.mockRejectedValueOnce(new Error("queue unavailable"));

    const handler = createForwarderHandler({ queue });

    const response = await handler(streamEvent());

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "100001" }]);
  });

  it("ignores MODIFY/REMOVE rows on the immutable log without failing them", async () => {
    const queue = queueSpy();
    const event: DynamoDBStreamEvent = {
      Records: [
        {
          eventID: "s:3",
          eventName: "MODIFY",
          eventSource: "aws:dynamodb",
          eventVersion: "1.1",
          awsRegion: "eu-west-2",
          dynamodb: {
            SequenceNumber: "100003",
            SizeBytes: 400,
            StreamViewType: "NEW_IMAGE",
            NewImage: { doc: { S: JSON.stringify(stagedDoc) } },
          },
        },
        {
          eventID: "s:4",
          eventName: "REMOVE",
          eventSource: "aws:dynamodb",
          eventVersion: "1.1",
          awsRegion: "eu-west-2",
          dynamodb: { SequenceNumber: "100004", SizeBytes: 400, StreamViewType: "NEW_IMAGE" },
        },
      ],
    };

    const handler = createForwarderHandler({ queue });

    const response = await handler(event);

    expect(queue.send).not.toHaveBeenCalled();
    expect(response.batchItemFailures).toEqual([]);
  });
});

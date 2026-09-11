import { SQSClient } from "@aws-sdk/client-sqs";
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { createSqsQueue, type Queue } from "@petroglyph/core";
import type { CloudEvent } from "@petroglyph/events";
import { forwardStreamRecords, type StreamRecordShape } from "./forwarder.js";

/**
 * 6.5.2.2 forwarder lambda: event-log DDB Streams → the staging domain's
 * internal FIFO queue. Row semantics come from forwardStreamRecords — this
 * shell isolates rows so a send failure becomes a Streams batch failure
 * (redelivered) while malformed rows are skipped with a loud log and never
 * retried.
 */
export function createForwarderHandler(deps: {
  queue: Queue<CloudEvent<unknown>>;
  log?: (message: string) => void;
}): (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse> {
  const log = deps.log ?? console.error;
  return async (event) => {
    const batchItemFailures: DynamoDBBatchResponse["batchItemFailures"] = [];
    for (const record of event.Records) {
      try {
        await forwardStreamRecords([toStreamRecordShape(record)], {
          queue: deps.queue,
          log,
        });
      } catch (error) {
        log(`[forwarder] failed to forward row: ${String(error)}`);
        const sequenceNumber = record.dynamodb?.SequenceNumber;
        if (sequenceNumber !== undefined) {
          batchItemFailures.push({ itemIdentifier: sequenceNumber });
        }
      }
    }
    return { batchItemFailures };
  };
}

/**
 * Projects the AWS record onto the forwarder's narrow shape: the forwarder
 * reads only `doc.S`, so only that attribute is carried across. Everything
 * else (MODIFY/REMOVE on the immutable log, non-string doc) hits the
 * forwarder's ignore path.
 */
function toStreamRecordShape(record: DynamoDBRecord): StreamRecordShape {
  const eventName: unknown = record.eventName;
  if (eventName !== "INSERT") {
    return { eventName };
  }
  const rawDoc: unknown = record.dynamodb?.NewImage?.["doc"];
  if (
    typeof rawDoc !== "object" ||
    rawDoc === null ||
    !("S" in rawDoc) ||
    typeof rawDoc["S"] !== "string"
  ) {
    return { eventName };
  }
  return {
    eventName,
    dynamodb: { NewImage: { doc: { S: rawDoc["S"] } } },
  };
}

export function createForwarderQueue(queueUrl: string): Queue<CloudEvent<unknown>> {
  return createSqsQueue({
    client: new SQSClient({}),
    queueUrl,
    // The domain's own encode: the same CE document consumers parse.
    encode: (message) => JSON.stringify(message),
  });
}

function stagedEventsQueueUrl(): string {
  const url = process.env["STAGED_EVENTS_QUEUE_URL"];
  if (url === undefined || url === "") {
    throw new Error("STAGED_EVENTS_QUEUE_URL env var not set");
  }
  return url;
}

export const handler = (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> =>
  createForwarderHandler({ queue: createForwarderQueue(stagedEventsQueueUrl()) })(event);

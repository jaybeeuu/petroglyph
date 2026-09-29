import { SQSClient } from "@aws-sdk/client-sqs";
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { createSqsQueue, type Queue } from "@petroglyph/core";
import type { CloudEvent, EventSource } from "@petroglyph/events";
import { createDdbStreamEventSource } from "./ddb-stream-event-source.js";
import { forwardStreamRecords } from "./forwarder.js";

/**
 * 6.5.2.2 forwarder lambda: event-log DDB Streams → the staging domain's
 * internal FIFO queue. Row semantics come from forwardStreamRecords — this
 * shell isolates rows so a send failure becomes a Streams batch failure
 * (redelivered) while malformed rows are skipped with a loud log and never
 * retried. The stream's wire shape lives behind the EventSource port.
 */
export function createForwarderHandler(deps: {
  queue: Queue<CloudEvent<unknown>>;
  source?: EventSource<DynamoDBRecord>;
  log?: (message: string) => void;
}): (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse> {
  const source = deps.source ?? createDdbStreamEventSource();
  const log = deps.log ?? console.error;
  return async (event) => {
    const batchItemFailures: DynamoDBBatchResponse["batchItemFailures"] = [];
    for (const record of event.Records) {
      try {
        await forwardStreamRecords([record], {
          source,
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

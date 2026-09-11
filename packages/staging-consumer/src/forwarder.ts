import type { Queue } from "@petroglyph/core";
import type { CloudEvent } from "@petroglyph/events";
import { fileDeletedEvent, fileStagedEvent } from "@petroglyph/staging-contracts";

export type StreamRecordType = "INSERT" | "MODIFY" | "REMOVE";

export interface StreamRecordShape {
  eventName?: unknown;
  dynamodb?: {
    NewImage?: { [key: string]: { S?: string } };
  };
}

export interface ForwardDependencies {
  queue: Queue<CloudEvent<unknown>>;
  log?: (message: string) => void;
}

export interface ForwardResult {
  forwarded: number;
  ignored: number;
  failed: number;
}

/**
 * 6.5.2.2 forwarder: DDB Streams rows on the immutable event log → the
 * staging domain's INTERNAL FIFO queue (MessageGroupId = profileId). Each row
 * is a CE document (Q8); rows are parsed through the registered events, so
 * only validated business events ever reach the queue. MODIFY/REMOVE on an
 * immutable log are ignored; malformed rows are skipped with a loud log and
 * the batch continues (Streams redelivers on batch failure, not per row).
 */
export async function forwardStreamRecords(
  records: StreamRecordShape[],
  deps: ForwardDependencies,
): Promise<ForwardResult> {
  const log = deps.log ?? console.error;
  let forwarded = 0;
  let ignored = 0;
  let failed = 0;

  for (const record of records) {
    if (record.eventName !== "INSERT") {
      ignored += 1;
      continue;
    }
    const rawDoc = record.dynamodb?.NewImage?.["doc"]?.["S"];
    if (rawDoc === undefined) {
      ignored += 1;
      continue;
    }

    let parsed: CloudEvent<unknown>;
    let document: unknown;
    try {
      document = JSON.parse(rawDoc);
    } catch (error) {
      failed += 1;
      log(`[forwarder] malformed event-log row (${rawDoc.slice(0, 120)}...): ${String(error)}`);
      continue;
    }

    try {
      parsed = fileStagedEvent.parse(document) as CloudEvent<unknown>;
    } catch {
      try {
        parsed = fileDeletedEvent.parse(document) as CloudEvent<unknown>;
      } catch (error) {
        failed += 1;
        log(`[forwarder] unparseable event-log row (${rawDoc.slice(0, 120)}...): ${String(error)}`);
        continue;
      }
    }

    const profileId = (parsed.data as { profileId?: unknown }).profileId;
    await deps.queue.send(parsed, {
      ...(typeof profileId === "string" ? { messageGroupId: profileId } : {}),
    });
    forwarded += 1;
  }

  return { forwarded, ignored, failed };
}

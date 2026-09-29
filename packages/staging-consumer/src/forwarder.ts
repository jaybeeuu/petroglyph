import type { Queue } from "@petroglyph/core";
import type { CloudEvent, EventSource } from "@petroglyph/events";
import { fileDeletedEvent, fileStagedEvent } from "@petroglyph/staging-contracts";

export interface ForwardDependencies<WireRecord> {
  source: EventSource<WireRecord>;
  queue: Queue<CloudEvent<unknown>>;
  log?: (message: string) => void;
}

export interface ForwardResult {
  forwarded: number;
  ignored: number;
  failed: number;
}

/**
 * 6.5.2.2 forwarder: event-log rows → the staging domain's INTERNAL FIFO queue
 * (MessageGroupId = profileId). Each row is a CE document (Q8); rows are parsed
 * through the registered events, so only validated business events ever reach
 * the queue. Rows the transport reports as carrying no event are ignored;
 * malformed rows are skipped with a loud log and the batch continues (Streams
 * redelivers on batch failure, not per row). The transport's wire shape lives
 * behind the EventSource port, not here.
 */
export async function forwardStreamRecords<WireRecord>(
  records: WireRecord[],
  deps: ForwardDependencies<WireRecord>,
): Promise<ForwardResult> {
  const log = deps.log ?? console.error;
  let forwarded = 0;
  let ignored = 0;
  let failed = 0;

  for (const record of records) {
    const rawDoc = deps.source.readDocument(record);
    if (rawDoc === undefined) {
      ignored += 1;
      continue;
    }

    let document: unknown;
    try {
      document = JSON.parse(rawDoc);
    } catch (error) {
      failed += 1;
      log(`[forwarder] malformed event-log row (${rawDoc.slice(0, 120)}...): ${String(error)}`);
      continue;
    }

    let parsed: CloudEvent<unknown>;
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

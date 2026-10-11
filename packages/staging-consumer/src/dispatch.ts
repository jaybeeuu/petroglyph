import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { CloudEvent } from "@petroglyph/events";
import {
  fileDeletedEvent,
  fileStagedEvent,
  type FileDeletedData,
  type FileStagedData,
  type StagedIndexStore,
  type StagedObjectStore,
} from "@petroglyph/staging-contracts";
import { applyDeleted, applyStaged } from "./index-apply.js";

export interface DispatchDependencies {
  index: StagedIndexStore;
  objectStore: StagedObjectStore;
  /**
   * Retention applied to newly staged rows, in seconds. Align it with the S3
   * expire-staged-pdfs lifecycle so the index row and its object age out
   * together. Omit to leave the row to the table's own policy.
   */
  ttlSeconds?: number;
  log?: (message: string) => void;
}

/** Best-effort identity for a message that failed to validate — never applied. */
function extractedIdentity(document: unknown): string {
  const data = (document as { data?: unknown } | null)?.data;
  if (typeof data !== "object" || data === null) {
    return "";
  }
  const fields: string[] = [];
  const { profileId, itemId, changeType } = data as {
    profileId?: unknown;
    itemId?: unknown;
    changeType?: unknown;
  };
  if (typeof profileId === "string") fields.push(`profileId=${profileId}`);
  if (typeof itemId === "string") fields.push(`itemId=${itemId}`);
  if (typeof changeType === "string") fields.push(`changeType=${changeType}`);
  return fields.length === 0 ? "" : ` (${fields.join(" ")})`;
}

/**
 * 6.5.2.3 dispatch seam: the staging domain's internal FIFO (staged_events) →
 * the staged index + S3. Each SQS record is a CE document the forwarder wrote
 * (JSON-encoded), validated through the registered events before anything is
 * applied. A message that fails to validate or apply is reported as an SQS
 * batch item failure and never partially applied; the rest of the batch
 * continues. One poison therefore retries alone.
 */
export function createDispatchHandler(
  deps: DispatchDependencies,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  const log = deps.log ?? console.error;
  return async (event) => {
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

    for (const record of event.Records) {
      let document: unknown;
      try {
        document = JSON.parse(record.body);
      } catch (error) {
        log(
          `[dispatch] malformed staged_events message messageId=${record.messageId}: ${String(error)}`,
        );
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const stagedResult = fileStagedEvent.safeParse(document);
      if (stagedResult.success) {
        const staged = stagedResult.data as CloudEvent<FileStagedData>;
        try {
          await applyStaged(deps.index, staged.data, {
            ...(deps.ttlSeconds === undefined ? {} : { ttlSeconds: deps.ttlSeconds }),
          });
          log(
            `[dispatch] applied petroglyph.file.staged profileId=${staged.data.profileId} itemId=${staged.data.itemId} changeType=${staged.data.changeType}`,
          );
        } catch (error) {
          log(
            `[dispatch] failed to apply messageId=${record.messageId} (petroglyph.file.staged profileId=${staged.data.profileId} itemId=${staged.data.itemId} changeType=${staged.data.changeType}): ${String(error)}`,
          );
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
        continue;
      }

      const deletedResult = fileDeletedEvent.safeParse(document);
      if (deletedResult.success) {
        const deleted = deletedResult.data as CloudEvent<FileDeletedData>;
        try {
          await applyDeleted(deps.index, deps.objectStore, deleted.data);
          log(
            `[dispatch] applied petroglyph.file.deleted profileId=${deleted.data.profileId} itemId=${deleted.data.itemId} changeType=${deleted.data.changeType}`,
          );
        } catch (error) {
          log(
            `[dispatch] failed to apply messageId=${record.messageId} (petroglyph.file.deleted profileId=${deleted.data.profileId} itemId=${deleted.data.itemId} changeType=${deleted.data.changeType}): ${String(error)}`,
          );
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
        continue;
      }

      log(
        `[dispatch] malformed staged_events message messageId=${record.messageId}${extractedIdentity(document)}: does not match a registered file event`,
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }

    return { batchItemFailures };
  };
}

import type { ObjectStore } from "@petroglyph/core";
import type { EventLogWriter } from "@petroglyph/events";
import { detectType } from "@petroglyph/staging-contracts";
import type { GraphClient } from "../tokens/graph-client.js";
import type { FileChangeEvent } from "../delta/delta-walk.js";
import { fetchItemContent } from "./fetch.js";
import { passesPreDownloadFilter } from "./gate.js";
import { deriveRemovedKey, landBytes } from "./land.js";
import { emitFileDeleted, emitFileStaged } from "./emit.js";

export type ProcessChangeOutcome = "landed" | "skipped" | "gate-rejected" | "deleted" | "fetch-404";

export interface ProcessChangeDeps {
  graph: GraphClient;
  store: ObjectStore;
  eventLog: EventLogWriter;
  /** CE id — reused on redelivery so the event log dedupes source+id. */
  emissionId: string;
  log?: (message: string) => void;
}

/**
 * The adapter's ONLY Unit-2 touchpoint (6.5.1.1): fetch → gate → land → emit.
 *
 * - created/updated: pre-download filter (claim OR .pdf extension) → fetch
 *   /content → detectType lands the truth → stage() → FileStagedEvent. A
 *   claim that survives the filter but not the bytes = no put, no event, the
 *   (claim, extension, detected) triple logged as lie telemetry.
 * - deleted: FileDeletedEvent with the DERIVED removal key (null for folders
 *   / when derivation is impossible). The adapter NEVER deletes S3 objects —
 *   Unit 2 acts on the event.
 * - put THEN emit: a crash between leaves an orphan object (invisible
 *   garbage) — beats an event referencing an absent object.
 */
export async function processChange(
  change: FileChangeEvent,
  deps: ProcessChangeDeps,
): Promise<ProcessChangeOutcome> {
  const log = deps.log ?? console.error;

  if (change.changeType === "deleted") {
    await emitFileDeleted(deps.eventLog, {
      change,
      s3Key: change.isFolder ? null : deriveRemovedKey(change),
      emissionId: deps.emissionId,
    });
    return "deleted";
  }

  if (!passesPreDownloadFilter(change)) {
    return "skipped";
  }

  const fetched = await fetchItemContent(deps.graph, change.itemId);
  if (fetched.kind === "not-found") {
    log(`[land] item ${change.itemId} vanished before fetch; next walk re-evaluates`);
    return "fetch-404";
  }

  const detected = detectType(fetched.bytes);
  if (detected === null) {
    log(
      `[land] lie telemetry — claim ${change.mimeType ?? "none"}, extension ${change.name}, detected null (${change.itemId})`,
    );
    return "gate-rejected";
  }

  const { s3Key } = await landBytes(deps.store, change, fetched.bytes, detected);
  await emitFileStaged(deps.eventLog, {
    change,
    s3Key,
    mimeType: detected,
    emissionId: deps.emissionId,
  });
  return "landed";
}

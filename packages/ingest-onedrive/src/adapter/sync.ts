import type { EventLogWriter } from "@petroglyph/events";
import type { StagedObjectStore } from "@petroglyph/staging-contracts";
import type { DeltaStateStore } from "../delta/delta-state-store.js";
import { type DeltaWalkProfile, type FileChangeEvent, walkDelta } from "../delta/delta-walk.js";
import type { GraphClient } from "../tokens/graph-client.js";
import { processChange } from "../land/process-change.js";

export interface DeltaSyncResult {
  outcome: "completed" | "failed";
  landed: number;
  deleted: number;
  skipped: number;
}

export interface RunDeltaSyncOptions {
  client: GraphClient;
  store: StagedObjectStore;
  eventLog: EventLogWriter;
  deltaStateStore: DeltaStateStore;
  connection: { userId: string; provider: string };
  profiles: DeltaWalkProfile[];
  initialUrl: string;
  log?: (message: string) => void;
}

/**
 * The adapter's lambda driver: one bell/Sync-Now trigger → walk the delta →
 * fetch + gate + land every change → emit business events to the registry.
 * The walker owns the change token; a failed walk processes nothing and the
 * caller redelivers. Each change's CE id is deterministic
 * (profileId:itemId:kind:version), so a redelivered trigger — or a restage of
 * the same revision — dedupes centrally at the event log, while two DISTINCT
 * updates to one item carry different eTags and so stay distinct.
 * landed/deleted count only writes the log accepted; a suppressed
 * re-emission ("deduped") counts as skipped.
 */
export async function runDeltaSync(options: RunDeltaSyncOptions): Promise<DeltaSyncResult> {
  const log = options.log ?? console.error;

  if (options.profiles.length === 0) {
    return { outcome: "completed", landed: 0, deleted: 0, skipped: 0 };
  }

  const walk = await walkDelta({
    client: options.client,
    store: options.deltaStateStore,
    connection: options.connection,
    profiles: options.profiles,
    initialUrl: options.initialUrl,
  });
  if (walk.outcome === "failed") {
    log(
      `[adapter] delta walk failed for ${options.connection.userId}/${options.connection.provider}`,
    );
    return { outcome: "failed", landed: 0, deleted: 0, skipped: 0 };
  }

  let landed = 0;
  let deleted = 0;
  let skipped = 0;
  for (const change of walk.events) {
    const outcome = await processChange(change, {
      graph: options.client,
      store: options.store,
      eventLog: options.eventLog,
      emissionId: emissionIdFor(change, log),
      log,
    });
    if (outcome === "landed") {
      landed += 1;
    } else if (outcome === "deleted") {
      deleted += 1;
    } else {
      // "deduped" lands here: the log already held source+id, so no write
      // happened and it must not inflate the landed/deleted counters.
      skipped += 1;
    }
  }

  return { outcome: "completed", landed, deleted, skipped };
}

/**
 * The CE id for one change: deterministic on (profile, item, kind, version).
 * The eTag is the content version, so it is the segment that keeps two
 * distinct updates to one item from colliding; source+id is then unique per
 * event and id is reused only for a re-send of the same revision (CE v1.0.2).
 * A deleted item carries no version, so its id deliberately falls back to the
 * 3-part profile:item:kind. A file change with no eTag is unexpected (the
 * delta `file` facet is selected), so it falls back too — and logs, because
 * the absence means the page contract is wrong and the second update would be
 * silently suppressed as a duplicate.
 */
function emissionIdFor(change: FileChangeEvent, log: (message: string) => void): string {
  const id = `${change.profileId}:${change.itemId}:${change.kind}`;
  if (change.kind !== "file") {
    return id;
  }
  if (change.eTag === undefined) {
    log(
      `[adapter] item ${change.itemId} has no eTag; emission id ${id} is unversioned and a later update will be suppressed as a duplicate`,
    );
    return id;
  }
  return `${id}:${change.eTag}`;
}

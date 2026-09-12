import type { ObjectStore } from "@petroglyph/core";
import type { EventLogWriter } from "@petroglyph/events";
import type { DeltaStateStore } from "../delta/delta-state-store.js";
import { type DeltaWalkProfile, walkDelta } from "../delta/delta-walk.js";
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
  store: ObjectStore;
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
 * (profileId:itemId:changeType) so a redelivered trigger — or a restage of
 * the same item — dedupes centrally at the event log.
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
      emissionId: emissionIdFor(change),
      log,
    });
    if (outcome === "landed") {
      landed += 1;
    } else if (outcome === "deleted") {
      deleted += 1;
    } else {
      skipped += 1;
    }
  }

  return { outcome: "completed", landed, deleted, skipped };
}

function emissionIdFor(change: { profileId: string; itemId: string; changeType: string }): string {
  return `${change.profileId}:${change.itemId}:${change.changeType}`;
}

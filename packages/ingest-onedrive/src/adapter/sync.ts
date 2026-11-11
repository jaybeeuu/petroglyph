import type { EventLogWriter } from "@petroglyph/events";
import type { StagedObjectStore } from "@petroglyph/staging-contracts";
import type { DeltaStateStore } from "../delta/delta-state-store.js";
import {
  type DeltaWalkProfile,
  type FileChangeEvent,
  type DeltaWalkFailure,
  walkDelta,
} from "../delta/delta-walk.js";
import type { GraphClient } from "../tokens/graph-client.js";
import { processChange } from "../land/process-change.js";

export interface DeltaSyncResult {
  outcome: "completed" | "failed";
  landed: number;
  deleted: number;
  skipped: number;
  /** Delta pages fetched and classified by this invocation. */
  pagesCompleted: number;
  /**
   * Whole pages left for a later invocation: 0 when the walk reached its
   * terminal change token, null when pages remain. Graph's delta reports no
   * total, so "some remain" is the most a deferred walk can honestly say.
   */
  pagesRemaining: number | null;
}

/**
 * A walk that spent its page budget hands this to the caller: the connection
 * whose walk stopped, and the opaque nextLink it stopped on. The resume link is
 * also the natural FIFO deduplication basis — two sends of the same resume
 * point are the same continuation, two different ones are different chunks of
 * the same catch-up.
 */
export interface DeltaContinuation {
  connection: { userId: string; provider: string };
  resumeLink: string;
}

export interface RunDeltaSyncOptions {
  client: GraphClient;
  store: StagedObjectStore;
  eventLog: EventLogWriter;
  deltaStateStore: DeltaStateStore;
  connection: { userId: string; provider: string };
  profiles: DeltaWalkProfile[];
  initialUrl: string;
  /** Pages this invocation may walk; see DeltaWalkOptions.pageBudget. */
  pageBudget?: number;
  /**
   * Enqueues the next bell after a walk spends its page budget. Required: a
   * deferred walk with nothing to continue it stops the catch-up dead, and the
   * stored resume link silently goes stale.
   */
  requestContinuation: (continuation: DeltaContinuation) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * The adapter's lambda driver: one bell/Sync-Now trigger → walk the delta →
 * fetch + gate + land every change → emit business events to the registry.
 * The walker owns the change token; a failed walk processes nothing the walk
 * did not reach, and the caller redelivers. Each change's CE id is deterministic
 * (profileId:itemId:kind:version), so a redelivered trigger — or a restage of
 * the same revision — dedupes centrally at the event log, while two DISTINCT
 * updates to one item carry different eTags and so stay distinct.
 * landed/deleted count only writes the log accepted; a suppressed
 * re-emission ("deduped") counts as skipped.
 *
 * A walk that spends its page budget is not a failure: the page it did fetch is
 * already landed, the resume point becomes the stored token, and a continuation
 * bell carries the walk on. That keeps one invocation well inside the Lambda
 * timeout, which a first walk over a whole drive never was.
 */
export async function runDeltaSync(options: RunDeltaSyncOptions): Promise<DeltaSyncResult> {
  const log = options.log ?? console.error;
  const connection = options.connection;

  if (options.profiles.length === 0) {
    return {
      outcome: "completed",
      landed: 0,
      deleted: 0,
      skipped: 0,
      pagesCompleted: 0,
      pagesRemaining: 0,
    };
  }

  // Counted as the walk hands each page over; a failed walk still reports what
  // it managed to land, because a redelivery must be readable from the log.
  let landed = 0;
  let deleted = 0;
  let skipped = 0;

  const walk = await walkDelta({
    client: options.client,
    store: options.deltaStateStore,
    connection,
    profiles: options.profiles,
    initialUrl: options.initialUrl,
    ...(options.pageBudget === undefined ? {} : { pageBudget: options.pageBudget }),
    // Land each page as the walk hands it over: the walk holds nothing between
    // pages, so peak memory is one page's changes and one item's content, not
    // the whole drive (petroglyph-63vq). A throw here (S3, DynamoDB) rejects the
    // walk, so the token stays where it was and the retry re-walks the page.
    handlePage: async (events) => {
      for (const change of events) {
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
    },
  });

  if (walk.outcome === "failed") {
    // Page progress AND the cause: a failed walk that reports no page count is
    // indistinguishable from one that never started, and a bare count leaves
    // the operator needing a manual Graph probe. The line carries no token,
    // resume link or presigned URL — item ids only.
    log(
      `[adapter] delta walk failed for ${connection.userId}/${connection.provider} ` +
        `after ${walk.pagesCompleted} page(s): ${describeFailure(walk.failure)}`,
    );
    return {
      outcome: "failed",
      landed,
      deleted,
      skipped,
      pagesCompleted: walk.pagesCompleted,
      pagesRemaining: null,
    };
  }

  if (walk.resumeLink !== undefined) {
    // Persist the resume point only now, with every change this invocation
    // fetched already in the event log. A crash anywhere above leaves the
    // previous token authoritative, so the retry re-walks the same pages and
    // the event log dedupes the repeats — nothing is skipped.
    await options.deltaStateStore.write(connection.userId, connection.provider, {
      deltaLink: walk.resumeLink,
      updatedAt: new Date().toISOString(),
    });
    await options.requestContinuation({ connection, resumeLink: walk.resumeLink });
    log(
      `[adapter] delta walk deferred for ${connection.userId}/${connection.provider}: ` +
        `${walk.pagesCompleted} page(s) completed, more remain — continuation enqueued`,
    );
    return {
      outcome: "completed",
      landed,
      deleted,
      skipped,
      pagesCompleted: walk.pagesCompleted,
      pagesRemaining: null,
    };
  }

  return {
    outcome: "completed",
    landed,
    deleted,
    skipped,
    pagesCompleted: walk.pagesCompleted,
    pagesRemaining: 0,
  };
}

/**
 * The failure cause in one line: the walk's reason, the page status or Graph
 * error code behind it, and the items it could not place. `reason` and
 * `unresolved` are always reported. `status` and `errorCode` appear when the
 * walk recorded them, both when both exist, and `ids` only when at least one
 * item is unplaced — a wedged connection names its own blockers.
 */
function describeFailure(failure: DeltaWalkFailure | undefined): string {
  if (failure === undefined) {
    return "cause unknown";
  }
  const parts = [`reason=${failure.reason}`];
  if (failure.status !== undefined) {
    parts.push(`status=${failure.status}`);
  }
  if (failure.errorCode !== undefined) {
    parts.push(`errorCode=${failure.errorCode}`);
  }
  parts.push(`unresolved=${failure.unresolvedItemIds.length}`);
  if (failure.unresolvedItemIds.length > 0) {
    parts.push(`ids=${failure.unresolvedItemIds.join(",")}`);
  }
  return parts.join(" ");
}

/**
 * The CE id for one change: deterministic on (profile, item, kind, version).
 * The eTag is the content version, so it is the segment that keeps two
 * distinct updates to one item from colliding; source+id is then unique per
 * event and id is reused only for a re-send of the same revision (CE v1.0.2).
 * A deleted item carries no version, so its id deliberately falls back to the
 * 3-part profile:item:kind. A file change with no eTag is unexpected (the
 * delta `$select` requests the top-level `eTag`), so it falls back too — and
 * logs, because the absence means the page contract is wrong and the second
 * update would be silently suppressed as a duplicate.
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

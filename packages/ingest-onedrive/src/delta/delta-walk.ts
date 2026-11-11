import { z } from "zod";
import { normalizeSourceFolderPath } from "@petroglyph/core";
import type { GraphClient } from "../tokens/graph-client.js";
import type { DeltaStateStore } from "./delta-state-store.js";

/**
 * A parsed driveItem carrying the `file` facet. `name` and `mimeType` are
 * optional because the wire may omit them; absence is never substituted.
 */
interface FileItem {
  kind: "file";
  itemId: string;
  name?: string;
  parentPath?: string;
  mimeType?: string;
  eTag?: string;
}

/** A parsed driveItem carrying only the `folder` facet. Never emitted. */
interface FolderItem {
  kind: "folder";
  itemId: string;
  name?: string;
  parentPath?: string;
}

/**
 * A parsed driveItem carrying the `deleted` facet. A deleted folder carries
 * BOTH `folder` and `deleted`, so deletion is the discriminator that wins.
 * Graph strips the name and the parent path on delete, so `name` and
 * `parentPath` are routinely absent and nothing may be rebuilt from them.
 */
interface DeletedItem {
  kind: "deleted";
  itemId: string;
  name?: string;
  parentPath?: string;
  isFolder: boolean;
}

type DriveItem = FileItem | FolderItem | DeletedItem;

/**
 * Tolerant wire schema for a delta page item. Graph may return facets this
 * adapter does not model, so unknown keys are stripped rather than rejected.
 * `eTag` is a top-level driveItem property, not part of the `file` facet
 * (`file` is `{ hashes, mimeType }` only). It is the version dimension
 * (`cTag` is not returned for folders, is unchanged by metadata-only edits,
 * and is omitted by delta on Create/Modify).
 */
const driveItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    // Top-level driveItem version property. Graph never returns it on the
    // `file` facet, so it must be read from here.
    eTag: z.string().min(1).optional(),
    // Graph delta supplies `parentReference.path` for items inside the drive;
    // the drive-root folder omits it. A present parentReference without path
    // must not fail the whole page (the root folder is always present).
    parentReference: z.object({ path: z.string().optional() }).optional(),
    file: z
      .object({
        mimeType: z.string().min(1).optional(),
      })
      .loose()
      .optional(),
    folder: z.record(z.string(), z.unknown()).optional(),
    deleted: z.record(z.string(), z.unknown()).optional(),
  })
  .transform((item): DriveItem => {
    // A deleted folder carries BOTH `folder` and `deleted`, so `deleted` is
    // tested first; otherwise a folder delete would be mis-tagged as a folder.
    if (item.deleted !== undefined) {
      return {
        kind: "deleted",
        itemId: item.id,
        ...(item.name === undefined ? {} : { name: item.name }),
        ...(item.parentReference?.path === undefined
          ? {}
          : { parentPath: item.parentReference.path }),
        isFolder: item.folder !== undefined,
      };
    }
    if (item.file !== undefined) {
      return {
        kind: "file",
        itemId: item.id,
        ...(item.name === undefined ? {} : { name: item.name }),
        ...(item.parentReference?.path === undefined
          ? {}
          : { parentPath: item.parentReference.path }),
        ...(item.file.mimeType === undefined ? {} : { mimeType: item.file.mimeType }),
        ...(item.eTag === undefined ? {} : { eTag: item.eTag }),
      };
    }
    return {
      kind: "folder",
      itemId: item.id,
      ...(item.name === undefined ? {} : { name: item.name }),
      ...(item.parentReference?.path === undefined
        ? {}
        : { parentPath: item.parentReference.path }),
    };
  });

const deltaPageSchema = z.object({
  value: z.array(driveItemSchema),
  "@odata.nextLink": z.string().min(1).optional(),
  "@odata.deltaLink": z.string().min(1).optional(),
});

/**
 * Adapter-internal change fact (6.5.2.1 contract). Never registered.
 * The `kind` facet replaces the phantom change-type property; created-vs-updated
 * is deliberately absent and is left to the version dimension (petroglyph-j1gn.17).
 */
export type FileChangeEvent =
  | {
      kind: "file";
      profileId: string;
      itemId: string;
      /** Absent when delta omitted it; never substituted with `itemId`. */
      name?: string;
      /** NORMALIZED here — the OneDrive parentReference.path format never leaks. */
      relativePath: string;
      /** Pre-download filter input only; never persisted, never in the event. */
      mimeType?: string;
      /** Version dimension consumed by petroglyph-j1gn.17. */
      eTag?: string;
    }
  | {
      kind: "deleted";
      profileId: string;
      itemId: string;
      /** Absent when delta omitted it; never substituted with `itemId`. */
      name?: string;
      /**
       * The PARENT folder path, present only when the wire carried it. Absent
       * on the delete Graph stripped — the common case, since a deletion is
       * carried by `itemId` alone and Unit 2 resolves it from its own record.
       */
      relativePath?: string;
      isFolder: boolean;
    };

export type DeltaWalkOutcome = "continued" | "reset" | "failed" | "deferred";

/**
 * Why a walk failed. Carried on the result so the caller can log the cause
 * without a second Graph probe: a page count alone cannot tell a throttled walk
 * from one that met a change it could not place.
 */
export interface DeltaWalkFailure {
  reason: "unresolved-items" | "page-status" | "invalid-page" | "no-links" | "token-rejected";
  /** HTTP status of the page that failed, when a page was involved. */
  status?: number;
  /** Graph error code from the failed page body, when present. */
  errorCode?: string;
  /** Emittable items the walk could not place. Empty unless the reason is unresolved-items. */
  unresolvedItemIds: string[];
}

export interface DeltaWalkResult {
  events: FileChangeEvent[];
  deltaLink?: string;
  outcome: DeltaWalkOutcome;
  /**
   * Delta pages fetched and classified by this invocation. Reported so an
   * operator can read how far one bell got — a walk that never finishes leaves
   * the same trace whether it is slow, throttled, or stuck.
   */
  pagesCompleted: number;
  /**
   * The nextLink the walk stopped on when the page budget ran out (outcome
   * `deferred`). The CALLER persists it: it becomes the stored token only after
   * this invocation's events are landed, so a crash before then leaves the
   * previous token authoritative and the retry re-walks the same pages instead
   * of skipping changes it never processed.
   */
  resumeLink?: string;
  /**
   * FILE items whose parent path is absent or not a recognised drive-root form
   * — "unknown", distinct from a drive-root item which normalises to "".
   * Folders are never emitted, so a path-less folder (the drive root) is
   * ignored rather than counted. A FILE needs a folder path to land under, so a
   * non-zero count fails the walk: an unresolvable file is visible, never
   * silently dropped while the change token advances.
   *
   * A path-less DELETION is deliberately not counted: it is carried by
   * `itemId` and resolved by Unit 2 from its own record, so no path is needed
   * and failing the walk would wedge the connection forever.
   */
  unresolvedPathCount: number;
  /**
   * Set only when `outcome` is "failed": the reason plus the status, Graph
   * error code and unresolved item ids an operator needs to read the cause
   * from the log alone.
   */
  failure?: DeltaWalkFailure;
  /**
   * Items that resolved to the drive root and so have no folder segment for a
   * staging key. Distinct from `unresolvedPathCount` (path unknown). Counted so
   * the drop is visible, but it does not fail the walk — root files are outside
   * the folder-scoped staging layout and must not block every other change.
   */
  driveRootItemCount: number;
  /**
   * True when the walk cleared the stored token and re-enumerated from
   * `initialUrl` because Graph rejected the token (410/syncStateNotFound). A
   * full resync is otherwise invisible to a caller that only reads `outcome`.
   */
  didReset: boolean;
}

export interface DeltaWalkProfile {
  profileId: string;
  /** Profile source-dir prefix; items outside every profile's prefix are dropped. */
  rootPath?: string;
}

export interface DeltaWalkOptions {
  client: GraphClient;
  store: DeltaStateStore;
  connection: { userId: string; provider: string };
  profiles: DeltaWalkProfile[];
  /** First-call (no token) full-enumeration URL. */
  initialUrl: string;
  /**
   * Maximum delta pages fetched in one invocation; defaults to
   * DEFAULT_PAGE_BUDGET. The adapter Lambda times out at 300 s and a first walk
   * over a whole drive is far more work than that, so the walk stops at a page
   * boundary, reports `deferred`, and hands the caller a resume link. One page
   * can carry up to 200 items, so this bounds walk requests, not landed items.
   */
  pageBudget?: number;
}

/**
 * One page per invocation. A page of delta items still has to be fetched, gated
 * and landed inside the 300 s adapter timeout, and that landing work — not the
 * page request — is what made the first whole-drive walk outlive the timeout.
 * A budget of one page means an invocation never queues a second page's work
 * behind an unlanded first one, and the continuation bell carries the walk on.
 */
export const DEFAULT_PAGE_BUDGET = 1;

/**
 * Strips up to the drive root: "/drive/root:/notes/sub" → "notes/sub".
 * Returns undefined when the path is absent or not in a recognised drive-root
 * form — "path unknown", distinct from "" ("item is at the drive root").
 * Graph returns `parentReference.path` for normal delta items; the drive root
 * omits it. A path-less FILE is the unexpected, fail-loud case; a path-less
 * deletion is the expected one, since Graph strips the path on delete.
 */
export function normalizeRelativePath(parentPath: string | undefined): string | undefined {
  if (parentPath === undefined) {
    return undefined;
  }
  const match = parentPath.match(/^(?:\/drive\/root|\/drives\/[^/]+\/root):?(?:\/(.*))?$/);
  if (match === null) {
    return undefined;
  }
  return (match[1] ?? "").replace(/\/+$/, "");
}

/** The Graph error code a failed page body carries, when it carries one. */
function graphErrorCode(body: unknown): string | undefined {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : undefined;
}

function isResetResponse(status: number, body: unknown): boolean {
  return status === 410 || graphErrorCode(body) === "syncStateNotFound";
}

/**
 * One delta request with the reset rule already applied. `didReset` records
 * that the request recovered from a rejected token by clearing the stored
 * token and re-enumerating from `initialUrl`; `unavailable` means the reset
 * itself was rejected, so the walk cannot continue.
 */
type Page =
  | { kind: "page"; status: number; body: unknown; didReset: boolean }
  | { kind: "unavailable"; status: number; body: unknown };

/**
 * Delta walk + change-token management. Full enumeration when no token is
 * stored; pages @odata.nextLink until the terminal @odata.deltaLink; writes
 * the state ONLY on successful completion; 410/syncStateNotFound clears the
 * token and re-enumerates from scratch (outcome reset, didReset true).
 *
 * The walk gives up the drive after `pageBudget` pages and reports `deferred`
 * with a `resumeLink` instead of paging on: a first walk over a whole drive is
 * more work than one Lambda invocation has, and running into the timeout
 * advances nothing. The caller lands the events it was given, persists the
 * resume link, and bells a continuation.
 */
export async function walkDelta(options: DeltaWalkOptions): Promise<DeltaWalkResult> {
  const stored = await options.store.read(options.connection.userId, options.connection.provider);

  // A stored profile path may predate write-side normalization (a leading slash
  // makes the prefix match unsatisfiable, so the profile silently ingests
  // nothing), so canonicalize here too: the walk is where the prefix is used.
  const profiles = options.profiles.map(
    (profile): DeltaWalkProfile =>
      profile.rootPath === undefined
        ? profile
        : { ...profile, rootPath: normalizeSourceFolderPath(profile.rootPath) },
  );

  const pageBudget = options.pageBudget ?? DEFAULT_PAGE_BUDGET;
  // Delta shows the latest state per item and may repeat an item within a walk,
  // so the last occurrence seen wins. Keyed by profile AND item: one path-less
  // deletion is reported against every candidate profile, and those are
  // distinct events for the same item id.
  const eventsByItemId = new Map<string, FileChangeEvent>();
  const collectEvents = (): FileChangeEvent[] => [...eventsByItemId.values()];
  const eventKey = (event: FileChangeEvent): string => `${event.profileId}:${event.itemId}`;

  let outcome: DeltaWalkOutcome = "continued";
  let didReset = false;
  let unresolvedPathCount = 0;
  let unresolvedItemIds: string[] = [];
  let driveRootItemCount = 0;
  let pagesCompleted = 0;

  /**
   * Request a page and apply the reset rule once: a rejected token clears the
   * stored token, re-enumerates from `initialUrl`, and reports `didReset`; a
   * reset that immediately resets again is `unavailable`.
   */
  const requestPage = async (url: string): Promise<Page> => {
    const response = await options.client.request(url);
    const body: unknown = await response.json().catch(() => null);
    if (!isResetResponse(response.status, body)) {
      return { kind: "page", status: response.status, body, didReset: false };
    }
    await options.store.clear(options.connection.userId, options.connection.provider);
    const fresh = await options.client.request(options.initialUrl);
    const freshBody: unknown = await fresh.json().catch(() => null);
    if (isResetResponse(fresh.status, freshBody)) {
      // A reset that immediately resets again cannot be recovered from.
      return { kind: "unavailable", status: fresh.status, body: freshBody };
    }
    return { kind: "page", status: fresh.status, body: freshBody, didReset: true };
  };

  const failed = (failure: DeltaWalkFailure): DeltaWalkResult => ({
    events: collectEvents(),
    outcome: "failed",
    unresolvedPathCount,
    failure,
    driveRootItemCount,
    didReset,
    pagesCompleted,
  });

  /** The cause for a page that answered with a status, and maybe a Graph code. */
  const pageFailure = (
    reason: DeltaWalkFailure["reason"],
    status: number,
    body: unknown,
  ): DeltaWalkFailure => {
    const errorCode = graphErrorCode(body);
    return {
      reason,
      status,
      ...(errorCode === undefined ? {} : { errorCode }),
      unresolvedItemIds,
    };
  };

  let page = await requestPage(stored?.deltaLink ?? options.initialUrl);

  while (true) {
    if (page.kind === "unavailable") {
      return failed(pageFailure("token-rejected", page.status, page.body));
    }
    if (page.didReset) {
      // The token was cleared and the drive re-enumerated — surface the reset.
      outcome = "reset";
      didReset = true;
    }
    if (page.status !== 200) {
      return failed(pageFailure("page-status", page.status, page.body));
    }
    const parsed = deltaPageSchema.safeParse(page.body);
    if (!parsed.success) {
      return failed(pageFailure("invalid-page", page.status, page.body));
    }

    const classified = classifyPage(parsed.data.value, profiles);
    pagesCompleted += 1;
    for (const event of classified.events) {
      eventsByItemId.set(eventKey(event), event);
    }
    unresolvedPathCount += classified.unresolvedPathCount;
    unresolvedItemIds = [...unresolvedItemIds, ...classified.unresolvedItemIds];
    driveRootItemCount += classified.driveRootItemCount;
    if (unresolvedPathCount > 0) {
      // A FILE with no folder path cannot be landed. Fail rather than report a
      // clean walk that advanced the change token past changes we never routed.
      return failed(pageFailure("unresolved-items", page.status, page.body));
    }

    const deltaLink = parsed.data["@odata.deltaLink"];
    if (deltaLink !== undefined) {
      await options.store.write(options.connection.userId, options.connection.provider, {
        deltaLink,
        updatedAt: new Date().toISOString(),
      });
      return {
        events: collectEvents(),
        deltaLink,
        outcome,
        unresolvedPathCount,
        driveRootItemCount,
        didReset,
        pagesCompleted,
      };
    }

    const nextLink = parsed.data["@odata.nextLink"];
    if (nextLink === undefined) {
      // Neither link: the walk never reached a terminal change token, so it
      // cannot claim success with the token left unadvanced.
      return failed(pageFailure("no-links", page.status, page.body));
    }

    if (pagesCompleted >= pageBudget) {
      // Stop at the page boundary and hand the walk to the caller. Continuing
      // would run a whole-drive first walk past the Lambda timeout, which is
      // how the change token stopped advancing in production.
      return {
        events: collectEvents(),
        outcome: "deferred",
        unresolvedPathCount,
        driveRootItemCount,
        didReset,
        pagesCompleted,
        resumeLink: nextLink,
      };
    }
    page = await requestPage(nextLink);
  }
}

interface PageClassification {
  events: FileChangeEvent[];
  unresolvedPathCount: number;
  driveRootItemCount: number;
}

interface PageClassification {
  events: FileChangeEvent[];
  unresolvedPathCount: number;
  unresolvedItemIds: string[];
  driveRootItemCount: number;
}

function classifyPage(items: DriveItem[], profiles: DeltaWalkProfile[]): PageClassification {
  const events: FileChangeEvent[] = [];
  let unresolvedPathCount = 0;
  const unresolvedItemIds: string[] = [];
  let driveRootItemCount = 0;
  for (const item of items) {
    const relativePath = normalizeRelativePath(item.parentPath);
    if (relativePath === undefined) {
      // Path unknown. A folder is the drive root (never emitted, never
      // unplaceable). A DELETION needs no path: Graph strips the name and the
      // parent path on delete, so the adapter carries the item id and Unit 2
      // resolves it from its own record — the only rule that can be true.
      // A FILE needs a folder path to land under, so it fails the walk loudly.
      if (item.kind === "deleted") {
        events.push(...deletionsForEveryProfile(item, profiles));
      } else if (item.kind === "file") {
        unresolvedPathCount += 1;
        unresolvedItemIds.push(item.itemId);
      }
      continue;
    }
    if (relativePath === "") {
      // Drive root: no folder segment, so no safe staging key. Count and skip,
      // never emit an empty relativePath into stage(). A root item is never
      // staged, so its deletion has no record to remove either.
      driveRootItemCount += 1;
      continue;
    }
    switch (item.kind) {
      case "file": {
        const event = classifyFile(item, profiles, relativePath);
        if (event !== null) {
          events.push(event);
        }
        break;
      }
      case "deleted": {
        const profile = routeToProfile(profiles, relativePath);
        if (profile !== undefined) {
          events.push(deletionEvent(item, profile, relativePath));
        }
        break;
      }
      case "folder":
        // Folders are classified by the wire schema but never emitted — only
        // file and delete changes carry content to stage or remove.
        break;
      default: {
        const unhandled: never = item;
        return unhandled;
      }
    }
  }
  return { events, unresolvedPathCount, unresolvedItemIds, driveRootItemCount };
}

function routeToProfile(
  profiles: DeltaWalkProfile[],
  relativePath: string,
): DeltaWalkProfile | undefined {
  return profiles.find(
    (profile) =>
      profile.rootPath === undefined ||
      profile.rootPath === "" ||
      profile.rootPath === "/" ||
      relativePath === profile.rootPath ||
      relativePath.startsWith(`${profile.rootPath}/`),
  );
}

function classifyFile(
  item: FileItem,
  profiles: DeltaWalkProfile[],
  relativePath: string,
): FileChangeEvent | null {
  const profile = routeToProfile(profiles, relativePath);
  if (profile === undefined) {
    return null;
  }
  return {
    kind: "file",
    profileId: profile.profileId,
    itemId: item.itemId,
    ...(item.name === undefined ? {} : { name: item.name }),
    relativePath,
    ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
    ...(item.eTag === undefined ? {} : { eTag: item.eTag }),
  };
}

/**
 * The deletion fact for one profile. `relativePath` is the PARENT folder path,
 * present only when the wire carried it; a path-less deletion carries the item
 * id alone.
 */
function deletionEvent(
  item: DeletedItem,
  profile: DeltaWalkProfile,
  relativePath: string | undefined,
): FileChangeEvent {
  return {
    kind: "deleted",
    profileId: profile.profileId,
    itemId: item.itemId,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(relativePath === undefined ? {} : { relativePath }),
    isFolder: item.isFolder,
  };
}

/**
 * A deletion with no path cannot be routed: the item id names the change, but
 * not the profile whose index holds its record. So every profile of the
 * connection is a candidate and Unit 2's lookup decides — removing a record
 * that does not exist is a no-op, and one drive cannot hold the same item under
 * two profiles, so at most one of these events removes anything.
 */
function deletionsForEveryProfile(
  item: DeletedItem,
  profiles: DeltaWalkProfile[],
): FileChangeEvent[] {
  return profiles.map((profile) => deletionEvent(item, profile, undefined));
}

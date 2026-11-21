import type { Operation } from "@petroglyph/contracts";
import { defineEndpoint, toHonoPath, type EndpointHandler } from "@petroglyph/contracts/hono";
import { getFile, listFiles } from "@petroglyph/contracts/operations";
import type { SyncProfile } from "@petroglyph/core";
import { isDeletedProfile } from "@petroglyph/core";
import type { StagedIndexStore, StagedObjectStore } from "@petroglyph/staging-contracts";
import { Hono } from "hono";
import { z } from "zod";
import { decodeFeedCursor, type FeedCursor } from "./cursor.js";
import { buildFeed, resolveOwnedEntry, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./feed.js";

export interface FilesRouterVariables {
  userId: string;
}

export interface FilesRouterDependencies {
  index: StagedIndexStore;
  objectStore: StagedObjectStore;
  /**
   * The named profile, or null when the caller owns no profile with that id.
   * READ-ONLY (decisions §9: never calls back).
   */
  readProfile: (userId: string, profileId: string) => Promise<SyncProfile | null>;
  presignTtlSeconds?: number;
}

/**
 * The `/files` query. The cursor is `nextToken`, the same name the response
 * body uses, so a caller can echo the token back without translating it.
 * `.strict()` is deliberate: a zod object otherwise strips an unknown key and
 * a misspelled cursor parameter degrades to "start again at page 1".
 */
const feedQuerySchema = z
  .object({
    nextToken: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

type FeedQuery = z.infer<typeof feedQuerySchema>;

type FeedQueryResult = { ok: true; data: FeedQuery } | { ok: false; error: z.ZodError };

/** The profile a page is read from, plus the index cursor when resuming. */
interface FeedScope {
  profileId: string;
  cursor?: string;
}

const INVALID_CURSOR = { error: "Invalid files cursor" };

const PROFILE_NOT_FOUND = { error: "Profile not found" };

const PROFILE_DELETED = {
  error: {
    code: "profile_deleted",
    message: "This profile has been deleted. Stop syncing it.",
  },
};

const FILE_NOT_FOUND = { error: "File not found" };

type FilesRouterEnv = { Variables: FilesRouterVariables };

/**
 * Registers one operation's handler chain on the router. Binding the route to the
 * registry entry is what puts the response the handler writes under the schema the
 * operation declares; `defineEndpoint` returns a chain whose length varies with the
 * request schemas, so its first middleware is named for Hono's handler-tuple
 * overloads. Auth is not part of this chain: the delivery app applies it to
 * `/files/*` before this router is mounted, so it still runs first.
 */
function mount<OperationDefinition extends Operation>(
  app: Hono<FilesRouterEnv>,
  operation: OperationDefinition,
  handler: EndpointHandler<OperationDefinition, FilesRouterEnv>,
): void {
  const [first, ...rest] = defineEndpoint(operation, handler);
  if (first === undefined) {
    throw new Error(`Operation "${operation.id}" produced no handlers`);
  }
  app.on(operation.method.toUpperCase(), toHonoPath(operation.path), first, ...rest);
}

function parseFeedQuery(query: { [key: string]: string }): FeedQueryResult {
  const parsed = feedQuerySchema.safeParse(query);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: parsed.error };
}

const FEED_QUERY_CONSTRAINTS: { [field: string]: string } = {
  nextToken: "must be a non-empty string",
  limit: `must be an integer between 1 and ${MAX_PAGE_SIZE}`,
};

/** Reports the offending field and its constraint — never the raw input. */
function describeFeedQueryError(error: z.ZodError): string {
  const details = error.issues.map((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => `${key} is not a supported parameter`).join("; ");
    }
    const field = issue.path.join(".") || "query";
    return `${field} ${FEED_QUERY_CONSTRAINTS[field] ?? "is invalid"}`;
  });
  return `Invalid files query: ${[...new Set(details)].join("; ")}`;
}

/**
 * Pins the whole pagination run to the named profile: a cursor naming any other
 * profile — or one that will not decode — is rejected, so a cursor cannot
 * silently re-scope the feed to a profile the caller did not name.
 */
function resolveFeedScope(query: FeedQuery, profileId: string): FeedScope | null {
  if (query.nextToken === undefined) {
    return { profileId };
  }
  let decoded: FeedCursor;
  try {
    decoded = decodeFeedCursor(query.nextToken);
  } catch {
    return null;
  }
  if (decoded.profileId !== profileId) {
    return null;
  }
  return { profileId, cursor: decoded.itemId };
}

function presignTtlOptions(ttlSeconds: number | undefined): { presignTtlSeconds?: number } {
  return ttlSeconds === undefined ? {} : { presignTtlSeconds: ttlSeconds };
}

/** What a profile-scoped request may read, decided once for both routes. */
type ProfileScope =
  | { readonly kind: "gone" }
  | { readonly kind: "missing" }
  | { readonly kind: "served"; readonly profileId: string }
  | { readonly kind: "disabled" };

/**
 * Resolves the profile named in the path. An unknown profile answers `404`; a
 * soft-deleted one answers `410` from the moment `deletedAt` is written, so a
 * deleted profile is never served as an empty feed — the client's prune step
 * would read that as "every file vanished". `enabled` gates the feed, and a
 * disabled profile serves nothing.
 */
async function resolveProfileScope(
  deps: FilesRouterDependencies,
  userId: string,
  profileId: string,
): Promise<ProfileScope> {
  const profile = await deps.readProfile(userId, profileId);
  if (profile === null || profile.userId !== userId) {
    return { kind: "missing" };
  }
  if (isDeletedProfile(profile)) {
    return { kind: "gone" };
  }
  if (!profile.enabled) {
    return { kind: "disabled" };
  }
  return { kind: "served", profileId: profile.profileId };
}

/**
 * 6ra.5.2.4 /files staging delivery surface — the plugin's ONLY file-flow
 * surface. It talks only to the OUTPUT of staging (index + S3): zero source
 * or ingest references here. Identity comes from the caller middleware
 * (GitHub JWT deferred as-is); scoping is user → profiles → records.
 */
export function createFilesRouter(deps: FilesRouterDependencies): Hono<{
  Variables: FilesRouterVariables;
}> {
  const app = new Hono<{ Variables: FilesRouterVariables }>();

  mount(app, listFiles, async (input, c) => {
    const query = parseFeedQuery(c.req.query());
    if (!query.ok) {
      return c.json({ error: describeFeedQueryError(query.error) }, 400);
    }

    const profile = await resolveProfileScope(deps, c.get("userId"), input.params.id);
    if (profile.kind === "missing") {
      return c.json(PROFILE_NOT_FOUND, 404);
    }
    if (profile.kind === "gone") {
      return c.json(PROFILE_DELETED, 410);
    }
    if (profile.kind === "disabled") {
      return c.json({ files: [], nextToken: null });
    }

    const scope = resolveFeedScope(query.data, profile.profileId);
    if (scope === null) {
      return c.json(INVALID_CURSOR, 400);
    }

    const result = await buildFeed({
      index: deps.index,
      objectStore: deps.objectStore,
      profileId: scope.profileId,
      limit: query.data.limit,
      ...(scope.cursor === undefined ? {} : { cursor: scope.cursor }),
      ...presignTtlOptions(deps.presignTtlSeconds),
    });
    return c.json({ files: result.files, nextToken: result.nextToken });
  });

  mount(app, getFile, async (input, c) => {
    const profile = await resolveProfileScope(deps, c.get("userId"), input.params.id);
    if (profile.kind === "missing" || profile.kind === "disabled") {
      return c.json(FILE_NOT_FOUND, 404);
    }
    if (profile.kind === "gone") {
      return c.json(PROFILE_DELETED, 410);
    }

    const entry = await resolveOwnedEntry({
      index: deps.index,
      objectStore: deps.objectStore,
      profileIds: [profile.profileId],
      itemId: input.params.itemId,
      ...presignTtlOptions(deps.presignTtlSeconds),
    });
    if (entry === null) {
      // 404, never 403: the record's existence is not leaked across users.
      return c.json(FILE_NOT_FOUND, 404);
    }
    return c.json(entry);
  });

  return app;
}

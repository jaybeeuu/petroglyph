import type { SyncProfile } from "@petroglyph/core";
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
  /** Neutral profile record read-back — READ-ONLY (decisions §9: never calls back). */
  listProfiles: (userId: string) => Promise<SyncProfile[]>;
  presignTtlSeconds?: number;
}

const feedQuerySchema = z.object({
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

type FeedQuery = z.infer<typeof feedQuerySchema>;

type FeedQueryResult = { ok: true; data: FeedQuery } | { ok: false; error: z.ZodError };

/** The profile a page is read from, plus the index cursor when resuming. */
interface FeedScope {
  profileId: string;
  cursor?: string;
}

const INVALID_CURSOR = { error: "Invalid files cursor" };

function parseFeedQuery(query: Record<string, string>): FeedQueryResult {
  const parsed = feedQuerySchema.safeParse(query);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: parsed.error };
}

const FEED_QUERY_CONSTRAINTS: Record<string, string> = {
  after: "must be a non-empty string",
  limit: `must be an integer between 1 and ${MAX_PAGE_SIZE}`,
};

/** Reports the offending field and its constraint — never the raw input. */
function describeFeedQueryError(error: z.ZodError): string {
  const fields = [...new Set(error.issues.map((issue) => issue.path.join(".") || "query"))];
  const details = fields.map(
    (field) => `${field} ${FEED_QUERY_CONSTRAINTS[field] ?? "is invalid"}`,
  );
  return `Invalid files query: ${details.join("; ")}`;
}

/**
 * Pins the whole pagination run to the active profile: a cursor naming any
 * other profile — or one that will not decode — is rejected, so a mid-
 * pagination active-profile change invalidates the page rather than silently
 * re-scoping the feed.
 */
function resolveFeedScope(query: FeedQuery, activeProfileId: string): FeedScope | null {
  if (query.after === undefined) {
    return { profileId: activeProfileId };
  }
  let decoded: FeedCursor;
  try {
    decoded = decodeFeedCursor(query.after);
  } catch {
    return null;
  }
  if (decoded.profileId !== activeProfileId) {
    return null;
  }
  return { profileId: activeProfileId, cursor: decoded.itemId };
}

function presignTtlOptions(ttlSeconds: number | undefined): { presignTtlSeconds?: number } {
  return ttlSeconds === undefined ? {} : { presignTtlSeconds: ttlSeconds };
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

  app.get("/files", async (c) => {
    const query = parseFeedQuery(c.req.query());
    if (!query.ok) {
      return c.json({ error: describeFeedQueryError(query.error) }, 400);
    }

    const profiles = await deps.listProfiles(c.get("userId"));
    const activeProfile = profiles.find((p) => p.active);
    if (activeProfile === undefined || !activeProfile.enabled) {
      return c.json({ files: [], nextToken: null });
    }

    const scope = resolveFeedScope(query.data, activeProfile.profileId);
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

  app.get("/files/:itemId", async (c) => {
    const profiles = await deps.listProfiles(c.get("userId"));
    if (profiles.length === 0) {
      return c.json({ error: "File not found" }, 404);
    }

    const entry = await resolveOwnedEntry({
      index: deps.index,
      objectStore: deps.objectStore,
      profileIds: profiles.map((p) => p.profileId),
      itemId: c.req.param("itemId"),
      ...presignTtlOptions(deps.presignTtlSeconds),
    });
    if (entry === null) {
      // 404, never 403: the record's existence is not leaked across users.
      return c.json({ error: "File not found" }, 404);
    }
    return c.json(entry);
  });

  return app;
}

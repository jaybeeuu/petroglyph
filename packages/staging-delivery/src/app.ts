import type { ObjectStore, SyncProfile } from "@petroglyph/core";
import type { StagedIndexStore } from "@petroglyph/staging-consumer";
import { Hono } from "hono";
import { z } from "zod";
import { decodeFeedCursor, type FeedCursor } from "./cursor.js";
import { buildFeed, resolveOwnedEntry, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./feed.js";

export interface FilesRouterVariables {
  userId: string;
}

export interface FilesRouterDependencies {
  index: StagedIndexStore;
  objectStore: ObjectStore;
  /** Neutral profile record read-back — READ-ONLY (decisions §9: never calls back). */
  listProfiles: (userId: string) => Promise<SyncProfile[]>;
  presignTtlSeconds?: number;
}

const feedQuerySchema = z.object({
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const INVALID_CURSOR = { error: "Invalid files cursor" };

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
    const query = feedQuerySchema.safeParse({
      after: c.req.query("after"),
      limit: c.req.query("limit"),
    });
    if (!query.success) {
      return c.json({ error: "Invalid files query" }, 400);
    }

    const profiles = await deps.listProfiles(c.get("userId"));
    const activeProfile = profiles.find((p) => p.active);
    if (activeProfile === undefined || !activeProfile.enabled) {
      return c.json({ files: [], nextToken: null });
    }

    let profileId = activeProfile.profileId;
    let cursor: string | undefined;
    if (query.data.after !== undefined) {
      let decoded: FeedCursor;
      try {
        decoded = decodeFeedCursor(query.data.after);
      } catch {
        return c.json(INVALID_CURSOR, 400);
      }
      if (!profiles.some((p) => p.profileId === decoded.profileId)) {
        return c.json(INVALID_CURSOR, 400);
      }
      profileId = decoded.profileId;
      cursor = decoded.itemId;
    }

    const result = await buildFeed({
      index: deps.index,
      objectStore: deps.objectStore,
      profileId,
      limit: query.data.limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(deps.presignTtlSeconds === undefined
        ? {}
        : { presignTtlSeconds: deps.presignTtlSeconds }),
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
      ...(deps.presignTtlSeconds === undefined
        ? {}
        : { presignTtlSeconds: deps.presignTtlSeconds }),
    });
    if (entry === null) {
      // 404, never 403: the record's existence is not leaked across users.
      return c.json({ error: "File not found" }, 404);
    }
    return c.json(entry);
  });

  return app;
}

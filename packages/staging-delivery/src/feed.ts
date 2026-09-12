import type { ObjectStore } from "@petroglyph/core";
import type { StagedIndexStore, StagedRecord } from "@petroglyph/staging-consumer";
import { encodeFeedCursor } from "./cursor.js";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PRESIGN_TTL_SECONDS = 15 * 60;

export interface FeedEntry {
  itemId: string;
  name: string;
  relativePath: string;
  mimeType: string;
  s3PresignedUrl: string;
  createdAt: string;
}

export interface FeedResult {
  files: FeedEntry[];
  /** Opaque cursor for the next page; null when the feed is exhausted. */
  nextToken: string | null;
}

export interface BuildFeedOptions {
  index: StagedIndexStore;
  objectStore: ObjectStore;
  profileId: string;
  limit?: number;
  /** Index cursor (itemId) — the page resumes exactly where the last stopped. */
  cursor?: string;
  presignTtlSeconds?: number;
}

/**
 * The delivery surface's ONLY read path: the index output + stored s3Key.
 * The s3Key is used verbatim for presigning — never derived here (the
 * staging layout is contract knowledge; readers follow stored keys).
 */
export async function buildFeed(options: BuildFeedOptions): Promise<FeedResult> {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  const page = await options.index.queryFeed({
    profileId: options.profileId,
    limit,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });

  const files = await Promise.all(
    page.records.map((record) =>
      entryFromRecord(record, options.objectStore, options.presignTtlSeconds),
    ),
  );

  return {
    files,
    nextToken:
      page.nextCursor === undefined
        ? null
        : encodeFeedCursor({ profileId: options.profileId, itemId: page.nextCursor }),
  };
}

/**
 * Resolves one owned record to a downloadable entry, or null when the item
 * belongs to no profile the caller may read (deleted or not theirs — auth
 * scoping resolves to 404, never 403, so existence is not leaked).
 */
export async function resolveOwnedEntry(options: {
  index: StagedIndexStore;
  objectStore: ObjectStore;
  profileIds: string[];
  itemId: string;
  presignTtlSeconds?: number;
}): Promise<FeedEntry | null> {
  for (const profileId of options.profileIds) {
    const record = await options.index.get(profileId, options.itemId);
    if (record === null) {
      continue;
    }
    return entryFromRecord(record, options.objectStore, options.presignTtlSeconds);
  }
  return null;
}

/** Content-Disposition override so the download lands as `<name>` regardless of s3Key. */
export function buildPresignedDisposition(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function entryFromRecord(
  record: StagedRecord,
  objectStore: ObjectStore,
  presignTtlSeconds: number | undefined,
): Promise<FeedEntry> {
  const s3PresignedUrl = await objectStore.presignGet(record.s3Key, {
    ttlSeconds: presignTtlSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS,
    responseContentDisposition: buildPresignedDisposition(record.name),
  });
  return {
    itemId: record.itemId,
    name: record.name,
    relativePath: record.relativePath,
    mimeType: record.mimeType,
    s3PresignedUrl,
    createdAt: record.createdAt,
  };
}

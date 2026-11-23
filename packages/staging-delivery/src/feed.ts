import type {
  StagedChange,
  StagedChangeLog,
  StagedIndexStore,
  StagedObjectStore,
  StagedRecord,
} from "@petroglyph/staging-contracts";
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
  /**
   * Opaque cursor for the next page; null when the log holds nothing after the
   * rows this page read. A client that writes this page and asks again with the
   * cursor gets nothing until a new change is logged.
   */
  nextToken: string | null;
}

export interface BuildFeedOptions {
  changeLog: StagedChangeLog;
  index: StagedIndexStore;
  objectStore: StagedObjectStore;
  profileId: string;
  limit?: number;
  /** The change-log seq the page resumes after. */
  after?: number;
  presignTtlSeconds?: number;
}

/**
 * The delivery surface's ONLY read path. The change log owns the change ORDER —
 * a re-staged item carries a new `seq`, so it is served again — and the index
 * owns the CURRENT bytes: each stage row is resolved to its record, and a row
 * whose record has been deleted is not served. Presigning uses the record's
 * stored s3Key verbatim (the staging layout is contract knowledge; readers
 * follow stored keys, never derive them).
 *
 * Delete rows are read but never served: removing a file from a vault is a
 * product decision that has not been made, so a delete only advances the
 * cursor.
 */
export async function buildFeed(options: BuildFeedOptions): Promise<FeedResult> {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  const changes = await options.changeLog.read({
    profileId: options.profileId,
    limit,
    ...(options.after === undefined ? {} : { after: options.after }),
  });

  const records = (
    await Promise.all(
      stagedItemIds(changes).map((itemId) => options.index.get(options.profileId, itemId)),
    )
  ).filter((record): record is StagedRecord => record !== null);
  const files = await Promise.all(
    records.map((record) =>
      entryFromRecord(record, options.objectStore, options.presignTtlSeconds),
    ),
  );

  const lastSeq = changes.at(-1)?.seq;
  return {
    files,
    nextToken:
      lastSeq === undefined
        ? null
        : encodeFeedCursor({ profileId: options.profileId, seq: lastSeq }),
  };
}

/**
 * The items this page tells the client about, in the order the log first names
 * them. Two stages of one item in a single page are one delivery: the index
 * holds only the latest bytes, so serving the item twice would deliver the same
 * file twice.
 */
function stagedItemIds(changes: StagedChange[]): string[] {
  return [
    ...new Set(changes.filter((change) => change.kind === "stage").map((change) => change.itemId)),
  ];
}

/**
 * Resolves one owned record to a downloadable entry, or null when the item
 * belongs to no profile the caller may read (deleted or not theirs — auth
 * scoping resolves to 404, never 403, so existence is not leaked).
 */
export async function resolveOwnedEntry(options: {
  index: StagedIndexStore;
  objectStore: StagedObjectStore;
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
  return `attachment; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/** RFC 5987 attr-char: ALPHA / DIGIT / ! # $ & + - . ^ _ ` | ~ */
const RFC_5987_ATTR_CHAR = /^[A-Za-z0-9!#$&+.^_`|~-]$/;

/**
 * Percent-encodes UTF-8 bytes outside the RFC 5987 attr-char set.
 * `encodeURIComponent` leaves `* ' ( )` unescaped, none of which are valid
 * attr-chars, so filenames containing them would produce a malformed header.
 */
function encodeRfc5987(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return RFC_5987_ATTR_CHAR.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

async function entryFromRecord(
  record: StagedRecord,
  objectStore: StagedObjectStore,
  presignTtlSeconds: number | undefined,
): Promise<FeedEntry> {
  return {
    itemId: record.itemId,
    name: record.name,
    relativePath: record.relativePath,
    mimeType: record.mimeType,
    s3PresignedUrl: await presign(record.s3Key, record.name, objectStore, presignTtlSeconds),
    createdAt: record.createdAt,
  };
}

function presign(
  s3Key: string,
  name: string,
  objectStore: StagedObjectStore,
  presignTtlSeconds: number | undefined,
): Promise<string> {
  return objectStore.presignGet(s3Key, {
    ttlSeconds: presignTtlSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS,
    responseContentDisposition: buildPresignedDisposition(name),
  });
}

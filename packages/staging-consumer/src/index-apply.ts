import type { ObjectStore } from "@petroglyph/core";
import type { FileDeletedData, FileStagedData } from "@petroglyph/staging-contracts";
import type { StagedIndexStore } from "./index-store.js";
import type { StagedRecord } from "./record.js";

export interface ApplyStagedOptions {
  createdAt?: string;
  /** Retention in seconds — the row's TTL aligns with S3 expire-staged-pdfs. */
  ttlSeconds?: number;
}

export async function applyStaged(
  store: StagedIndexStore,
  data: FileStagedData,
  options: ApplyStagedOptions = {},
): Promise<void> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const record: StagedRecord = {
    profileId: data.profileId,
    itemId: data.itemId,
    s3Key: data.s3Key,
    relativePath: data.relativePath,
    name: data.name,
    source: data.source,
    mimeType: data.mimeType,
    status: "staged",
    createdAt,
    ...(options.ttlSeconds === undefined
      ? {}
      : { expiresAt: Math.floor(Date.parse(createdAt) / 1000) + options.ttlSeconds }),
  };
  // Idempotent blind write: same {profileId, itemId} → same record, never a dup.
  await store.upsert(record);
}

/**
 * Deletes apply from the event (6.5.2.2 is the ONLY deleter — the adapter
 * never touches S3). s3Key string → object deleted by key + record removed
 * by itemId; a re-delete of an already-removed record is a true no-op.
 * s3Key null → the REMOVED PATH (folder path-level, or a path-unknown
 * item) sweeps every record under it and deletes their objects; a
 * file-path sweep matches nothing.
 */
export async function applyDeleted(
  store: StagedIndexStore,
  objectStore: ObjectStore,
  data: FileDeletedData,
): Promise<void> {
  const existing = await store.get(data.profileId, data.itemId);
  if (existing !== null && data.s3Key !== null) {
    await objectStore.delete(data.s3Key);
  }
  await store.remove(data.profileId, data.itemId);

  if (data.s3Key === null) {
    const under = await store.listUnderPath(data.profileId, data.relativePath);
    for (const record of under) {
      await objectStore.delete(record.s3Key);
    }
    await store.removeUnderPath(data.profileId, data.relativePath);
  }
}

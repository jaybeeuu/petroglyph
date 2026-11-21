import type {
  FileDeletedData,
  FileStagedData,
  StagedIndexStore,
  StagedObjectStore,
  StagedRecord,
} from "@petroglyph/staging-contracts";

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
    ...(data.eTag === undefined ? {} : { eTag: data.eTag }),
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
 * never touches S3). The object is named by the STORED record's `s3Key`, never
 * by the event: the adapter does not own the key, and a null or absent event
 * key must not remove the record while leaving the object behind.
 *
 * A record that was never staged is a true no-op — the re-delete of an already
 * removed record included.
 *
 * The sweep stays for the one deletion the adapter can place: a deleted folder
 * whose own path it knew. The event then carries `relativePath` with no
 * `s3Key`, and every record under that path loses its object and its row.
 * A path-less deletion carries no hint, so nothing is swept.
 */
export async function applyDeleted(
  store: StagedIndexStore,
  objectStore: StagedObjectStore,
  data: FileDeletedData,
): Promise<void> {
  const existing = await store.get(data.profileId, data.itemId);
  if (existing !== null) {
    await objectStore.delete(existing.s3Key);
  }
  await store.remove(data.profileId, data.itemId);

  if (data.relativePath !== undefined && (data.s3Key === undefined || data.s3Key === null)) {
    const under = await store.listUnderPath(data.profileId, data.relativePath);
    for (const record of under) {
      await objectStore.delete(record.s3Key);
    }
    await store.removeUnderPath(data.profileId, data.relativePath);
  }
}

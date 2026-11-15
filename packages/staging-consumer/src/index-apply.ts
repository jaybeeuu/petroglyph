import {
  subscriptionIdOf,
  type FileDeletedData,
  type FileStagedData,
  type StagedChangeInput,
  type StagedChangeLog,
  type StagedIndexStore,
  type StagedObjectStore,
  type StagedRecord,
} from "@petroglyph/staging-contracts";

export interface ApplyStagedOptions {
  index: StagedIndexStore;
  changeLog: StagedChangeLog;
  /** The CloudEvent id: the change's identity, so a redelivery logs once. */
  changeId: string;
  data: FileStagedData;
  createdAt?: string;
  /** Retention in seconds — the row's TTL aligns with S3 expire-staged-pdfs. */
  ttlSeconds?: number;
}

export async function applyStaged(options: ApplyStagedOptions): Promise<void> {
  const { data } = options;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const subscriptionId = subscriptionIdOf(data);
  const record: StagedRecord = {
    profileId: data.profileId,
    subscriptionId,
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
  await options.index.upsert(record);

  // The record is the read model; the log row is the change the client is told
  // about, and a re-stage of the same item with a new eTag appends a new seq.
  await options.changeLog.append({
    profileId: data.profileId,
    subscriptionId,
    changeId: options.changeId,
    itemId: data.itemId,
    kind: "stage",
    relativePath: data.relativePath,
    name: data.name,
    mimeType: data.mimeType,
    s3Key: data.s3Key,
    ...(data.eTag === undefined ? {} : { eTag: data.eTag }),
    recordedAt: createdAt,
  });
}

export interface ApplyDeletedOptions {
  index: StagedIndexStore;
  objectStore: StagedObjectStore;
  changeLog: StagedChangeLog;
  /** The CloudEvent id of the deleted item. */
  changeId: string;
  data: FileDeletedData;
  createdAt?: string;
}

/**
 * Deletes apply from the event (6.5.2.2 is the ONLY deleter — the adapter
 * never touches S3). The object is named by the STORED record's `s3Key`, never
 * by the event: the adapter does not own the key, and a null or absent event
 * key must not remove the record while leaving the object behind.
 *
 * A record that was never staged is a true no-op for storage — the re-delete of
 * an already removed record included.
 *
 * Both the item and every record removed by a folder sweep append a delete row,
 * so a client can learn that what it holds is gone. Each swept row derives its
 * own change id from the sweep change id and the record's item id, because one
 * event legitimises many removals.
 *
 * The sweep stays for the one deletion the adapter can place: a deleted folder
 * whose own path it knew. The event then carries `relativePath` with no
 * `s3Key`, and every record under that path loses its object and its row.
 * A path-less deletion carries no hint, so nothing is swept.
 */
export async function applyDeleted(options: ApplyDeletedOptions): Promise<void> {
  const { data } = options;
  const recordedAt = options.createdAt ?? new Date().toISOString();
  const subscriptionId = subscriptionIdOf(data);
  const existing = await options.index.get(data.profileId, data.itemId);
  if (existing !== null) {
    await options.objectStore.delete(existing.s3Key);
  }
  await options.index.remove(data.profileId, data.itemId);
  await options.changeLog.append(
    deleteChange({
      profileId: data.profileId,
      subscriptionId,
      changeId: options.changeId,
      itemId: data.itemId,
      relativePath: existing?.relativePath ?? "",
      ...(existing === null ? {} : { name: existing.name }),
      recordedAt,
    }),
  );

  if (data.relativePath !== undefined && (data.s3Key === undefined || data.s3Key === null)) {
    const under = await options.index.listUnderPath(data.profileId, data.relativePath);
    for (const record of under) {
      await options.objectStore.delete(record.s3Key);
    }
    await options.index.removeUnderPath(data.profileId, data.relativePath);
    for (const record of under) {
      await options.changeLog.append(
        deleteChange({
          profileId: record.profileId,
          subscriptionId: record.subscriptionId,
          changeId: `${options.changeId}:${record.itemId}`,
          itemId: record.itemId,
          relativePath: record.relativePath,
          name: record.name,
          recordedAt,
        }),
      );
    }
  }
}

function deleteChange(change: {
  profileId: string;
  subscriptionId: string;
  changeId: string;
  itemId: string;
  relativePath: string;
  name?: string;
  recordedAt: string;
}): StagedChangeInput {
  return {
    profileId: change.profileId,
    subscriptionId: change.subscriptionId,
    changeId: change.changeId,
    itemId: change.itemId,
    kind: "delete",
    relativePath: change.relativePath,
    ...(change.name === undefined ? {} : { name: change.name }),
    recordedAt: change.recordedAt,
  };
}

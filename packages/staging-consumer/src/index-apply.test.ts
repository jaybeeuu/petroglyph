import { describe, expect, it } from "vitest";
import {
  stagedRecordSchema,
  type FileDeletedData,
  type FileStagedData,
  type StagedChange,
  type StagedChangeInput,
  type StagedChangeLog,
  type StagedIndexStore,
  type StagedObjectStore,
  type StagedRecord,
} from "@petroglyph/staging-contracts";
import { applyDeleted, applyStaged } from "./index-apply.js";

/** In-memory index store — unit fixture matching the interface contract. */
function createIndexStore(): StagedIndexStore & { records: StagedRecord[] } {
  const records: StagedRecord[] = [];
  return {
    records,
    upsert(record) {
      const existing = records.findIndex(
        (r) => r.profileId === record.profileId && r.itemId === record.itemId,
      );
      if (existing >= 0) {
        records.splice(existing, 1, record);
      } else {
        records.push(record);
      }
      return Promise.resolve();
    },
    get(profileId, itemId) {
      return Promise.resolve(
        records.find((r) => r.profileId === profileId && r.itemId === itemId) ?? null,
      );
    },
    remove(profileId, itemId) {
      const index = records.findIndex((r) => r.profileId === profileId && r.itemId === itemId);
      if (index >= 0) records.splice(index, 1);
      return Promise.resolve();
    },
    listUnderPath(profileId, path) {
      return Promise.resolve(
        records.filter(
          (r) =>
            r.profileId === profileId &&
            (r.relativePath === path || r.relativePath.startsWith(`${path}/`)),
        ),
      );
    },
    removeUnderPath(profileId, path) {
      const doomed = records.filter(
        (r) =>
          r.profileId === profileId &&
          (r.relativePath === path || r.relativePath.startsWith(`${path}/`)),
      );
      for (const record of doomed) {
        const index = records.indexOf(record);
        if (index >= 0) records.splice(index, 1);
      }
      return Promise.resolve();
    },
  };
}

/**
 * In-memory change log honouring its contract: one row per change id, seq
 * allocated in append order. The DynamoDB implementation of the same contract
 * is covered against LocalStack in `staging-contracts`.
 */
function createChangeLog(): StagedChangeLog & { changes: StagedChange[] } {
  const changes: StagedChange[] = [];
  return {
    changes,
    append(change: StagedChangeInput) {
      if (changes.some((existing) => existing.changeId === change.changeId)) {
        return Promise.resolve({ status: "duplicate" as const });
      }
      changes.push({ ...change, seq: changes.length + 1 });
      return Promise.resolve({ status: "appended" as const });
    },
    read(options) {
      return Promise.resolve(
        changes
          .filter((change) => change.profileId === options.profileId)
          .sort((left, right) => left.seq - right.seq),
      );
    },
  };
}

function objectStoreSpy(): { objectStore: StagedObjectStore; deleteCalls: string[] } {
  const deleteCalls: string[] = [];
  const objectStore = {
    delete: (key: string) => {
      deleteCalls.push(key);
      return Promise.resolve();
    },
  } as unknown as StagedObjectStore;
  return { objectStore, deleteCalls };
}

const staged: FileStagedData = {
  profileId: "p1",
  source: "onedrive",
  changeType: "created",
  itemId: "item-1",
  name: "a.pdf",
  relativePath: "notes",
  s3Key: "staging/v1/p1/notes/a.pdf",
  mimeType: "application/pdf",
};

const staged2: FileStagedData = {
  ...staged,
  itemId: "item-2",
  name: "b.pdf",
  s3Key: "staging/v1/p1/notes/b.pdf",
};

const deletedItem: FileDeletedData = {
  profileId: "p1",
  source: "onedrive",
  changeType: "deleted",
  itemId: "item-1",
};

// Legacy event-log row: the adapter used to guess the key, so the event carries
// one. It must never override the key the index actually stored.
const deletedStaleKey: FileDeletedData = {
  ...deletedItem,
  relativePath: "notes/a.pdf",
  s3Key: "staging/v1/p1/notes/stale-name.pdf",
};

const deletedNullKey: FileDeletedData = {
  ...deletedItem,
  relativePath: "notes/a.pdf",
  s3Key: null,
};

const deletedFolder: FileDeletedData = {
  profileId: "p1",
  source: "onedrive",
  changeType: "deleted",
  itemId: "folder-1",
  relativePath: "notes/sub",
  s3Key: null,
};

function recordFor(data: FileStagedData): StagedRecord {
  return stagedRecordSchema.parse({
    profileId: data.profileId,
    subscriptionId: data.profileId,
    itemId: data.itemId,
    s3Key: data.s3Key,
    relativePath: data.relativePath,
    name: data.name,
    source: data.source,
    mimeType: data.mimeType,
    status: "staged",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
}

describe("applyStaged", () => {
  it("upserts the {profileId, itemId} record and logs the change", async () => {
    const index = createIndexStore();
    const changeLog = createChangeLog();

    await applyStaged({
      index,
      changeLog,
      changeId: "p1:item-1:file:etag-1",
      data: { ...staged, eTag: "etag-1" },
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    expect(index.records).toHaveLength(1);
    expect(index.records[0]).toMatchObject({
      profileId: "p1",
      subscriptionId: "p1",
      itemId: "item-1",
      s3Key: "staging/v1/p1/notes/a.pdf",
      relativePath: "notes",
      name: "a.pdf",
      source: "onedrive",
      mimeType: "application/pdf",
      status: "staged",
    });
    expect(changeLog.changes).toEqual([
      {
        profileId: "p1",
        subscriptionId: "p1",
        seq: 1,
        changeId: "p1:item-1:file:etag-1",
        itemId: "item-1",
        kind: "stage",
        relativePath: "notes",
        name: "a.pdf",
        mimeType: "application/pdf",
        s3Key: "staging/v1/p1/notes/a.pdf",
        eTag: "etag-1",
        recordedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });

  it("a redelivered change logs one row and the next change keeps the next seq", async () => {
    const index = createIndexStore();
    const changeLog = createChangeLog();
    const delivery = {
      index,
      changeLog,
      changeId: "p1:item-1:file:etag-1",
      data: { ...staged, eTag: "etag-1" },
      createdAt: "2026-09-01T00:00:00.000Z",
    };

    await applyStaged(delivery);
    await applyStaged(delivery);
    await applyStaged({
      ...delivery,
      changeId: "p1:item-2:file:etag-1",
      data: { ...staged2, eTag: "etag-1" },
    });

    expect(changeLog.changes.map((change) => [change.seq, change.itemId])).toEqual([
      [1, "item-1"],
      [2, "item-2"],
    ]);
  });

  it("a re-stage of the same item with a new eTag logs a new seq", async () => {
    const index = createIndexStore();
    const changeLog = createChangeLog();

    await applyStaged({
      index,
      changeLog,
      changeId: "p1:item-1:file:etag-1",
      data: { ...staged, eTag: "etag-1" },
    });
    await applyStaged({
      index,
      changeLog,
      changeId: "p1:item-1:file:etag-2",
      data: { ...staged, eTag: "etag-2" },
    });

    expect(changeLog.changes.map((change) => [change.seq, change.eTag])).toEqual([
      [1, "etag-1"],
      [2, "etag-2"],
    ]);
    // One record still: the index holds the latest bytes of the item.
    expect(index.records).toHaveLength(1);
    expect(index.records[0]?.s3Key).toBe("staging/v1/p1/notes/a.pdf");
  });

  it("writes the expiry aligned to the S3 lifecycle when ttlSeconds is configured", async () => {
    const index = createIndexStore();

    await applyStaged({
      index,
      changeLog: createChangeLog(),
      changeId: "p1:item-1:file:etag-1",
      data: staged,
      createdAt: "2026-09-01T00:00:00.000Z",
      ttlSeconds: 30 * 86400,
    });

    const createdAtEpoch = Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1000);
    expect(index.records[0]?.expiresAt).toBe(createdAtEpoch + 30 * 86400);
  });
});

describe("applyDeleted", () => {
  it("removes the record, deletes the object at the STORED key and logs the delete; re-delete is one row", async () => {
    const index = createIndexStore();
    const changeLog = createChangeLog();
    const { objectStore, deleteCalls } = objectStoreSpy();
    await applyStaged({
      index,
      changeLog,
      changeId: "p1:item-1:file:etag-1",
      data: staged,
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    const deletion = {
      index,
      objectStore,
      changeLog,
      changeId: "p1:item-1:deleted:",
      data: deletedItem,
      createdAt: "2026-09-01T00:00:01.000Z",
    };
    await applyDeleted(deletion);
    await applyDeleted(deletion);

    expect(index.records).toHaveLength(0);
    expect(deleteCalls).toEqual(["staging/v1/p1/notes/a.pdf"]);
    expect(changeLog.changes.map((change) => [change.seq, change.kind])).toEqual([
      [1, "stage"],
      [2, "delete"],
    ]);
  });

  it("logs a delete row that names the item but no bytes", async () => {
    const index = createIndexStore();
    const changeLog = createChangeLog();
    const { objectStore } = objectStoreSpy();
    await applyStaged({
      index,
      changeLog,
      changeId: "p1:item-1:file:etag-1",
      data: staged,
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    await applyDeleted({
      index,
      objectStore,
      changeLog,
      changeId: "p1:item-1:deleted:",
      data: deletedItem,
      createdAt: "2026-09-01T00:00:01.000Z",
    });

    expect(changeLog.changes[1]).toEqual({
      profileId: "p1",
      subscriptionId: "p1",
      seq: 2,
      changeId: "p1:item-1:deleted:",
      itemId: "item-1",
      kind: "delete",
      relativePath: "notes",
      name: "a.pdf",
      recordedAt: "2026-09-01T00:00:01.000Z",
    });
  });

  it("an event key never overrides the stored key, so a stale guess cannot orphan the object", async () => {
    const index = createIndexStore();
    const { objectStore, deleteCalls } = objectStoreSpy();
    await applyStaged({
      index,
      changeLog: createChangeLog(),
      changeId: "p1:item-1:file:etag-1",
      data: staged,
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    await applyDeleted({
      index,
      objectStore,
      changeLog: createChangeLog(),
      changeId: "p1:item-1:deleted:",
      data: deletedStaleKey,
    });

    expect(index.records).toHaveLength(0);
    expect(deleteCalls).toEqual(["staging/v1/p1/notes/a.pdf"]);
  });

  it("a null event s3Key still deletes the stored object, so removing the record never orphans it", async () => {
    const index = createIndexStore();
    const { objectStore, deleteCalls } = objectStoreSpy();
    await applyStaged({
      index,
      changeLog: createChangeLog(),
      changeId: "p1:item-1:file:etag-1",
      data: staged,
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    await applyDeleted({
      index,
      objectStore,
      changeLog: createChangeLog(),
      changeId: "p1:item-1:deleted:",
      data: deletedNullKey,
    });

    expect(index.records).toHaveLength(0);
    expect(deleteCalls).toEqual(["staging/v1/p1/notes/a.pdf"]);
  });

  it("a delete for a record that was never staged removes and deletes nothing", async () => {
    const index = createIndexStore();
    const { objectStore, deleteCalls } = objectStoreSpy();

    await applyDeleted({
      index,
      objectStore,
      changeLog: createChangeLog(),
      changeId: "p1:item-1:deleted:",
      data: deletedItem,
    });

    expect(index.records).toHaveLength(0);
    expect(deleteCalls).toEqual([]);
  });

  it("folder path-level delete: sweeps every record under the path, logs one delete row each; repeat is a no-op", async () => {
    const index = createIndexStore();
    const changeLog = createChangeLog();
    const child = {
      ...staged2,
      itemId: "deep-item",
      name: "c.pdf",
      relativePath: "notes/sub",
      s3Key: "staging/v1/p1/notes/sub/c.pdf",
    };
    const deeper = {
      ...staged2,
      itemId: "deeper-item",
      name: "d.pdf",
      relativePath: "notes/sub/deep",
      s3Key: "staging/v1/p1/notes/sub/deep/d.pdf",
    };
    const sibling = {
      ...staged2,
      itemId: "sibling",
      name: "e.pdf",
      relativePath: "notes/other",
      s3Key: "staging/v1/p1/notes/other/e.pdf",
    };
    index.records.push(recordFor(child), recordFor(deeper), recordFor(sibling));
    const { objectStore, deleteCalls } = objectStoreSpy();

    const sweep = {
      index,
      objectStore,
      changeLog,
      changeId: "p1:folder-1:deleted:",
      data: deletedFolder,
      createdAt: "2026-09-01T00:00:02.000Z",
    };
    await applyDeleted(sweep);
    await applyDeleted(sweep);

    expect(index.records.map((r) => r.itemId)).toEqual(["sibling"]);
    expect(deleteCalls).toEqual([
      "staging/v1/p1/notes/sub/c.pdf",
      "staging/v1/p1/notes/sub/deep/d.pdf",
    ]);
    // The folder itself, then one row per swept record, each with its own
    // change id — one event legitimises several removals.
    expect(changeLog.changes.map((change) => [change.itemId, change.changeId])).toEqual([
      ["folder-1", "p1:folder-1:deleted:"],
      ["deep-item", "p1:folder-1:deleted::deep-item"],
      ["deeper-item", "p1:folder-1:deleted::deeper-item"],
    ]);
  });

  // The accepted gap (petroglyph-9lcj, covered long term by petroglyph-1ey8):
  // a folder deletion with no path on the wire cannot sweep, so a child that
  // never arrives as its own delta item keeps its record until the row TTL.
  it("a path-less folder delete removes only its own record and leaves children in place", async () => {
    const index = createIndexStore();
    const child = {
      ...staged2,
      itemId: "deep-item",
      name: "c.pdf",
      relativePath: "notes/sub",
      s3Key: "staging/v1/p1/notes/sub/c.pdf",
    };
    index.records.push(recordFor(child));
    const { objectStore, deleteCalls } = objectStoreSpy();

    await applyDeleted({
      index,
      objectStore,
      changeLog: createChangeLog(),
      changeId: "p1:folder-1:deleted:",
      data: {
        profileId: "p1",
        source: "onedrive",
        changeType: "deleted",
        itemId: "folder-1",
      },
    });

    expect(index.records.map((r) => r.itemId)).toEqual(["deep-item"]);
    expect(deleteCalls).toEqual([]);
  });

  it("keeps the subscription id the event carried, so the row names its root", async () => {
    const index = createIndexStore();
    const changeLog = createChangeLog();

    await applyStaged({
      index,
      changeLog,
      changeId: "p1:item-1:file:etag-1",
      data: { ...staged, subscriptionId: "subscription-7" },
    });

    expect(index.records[0]?.subscriptionId).toBe("subscription-7");
    expect(changeLog.changes[0]?.subscriptionId).toBe("subscription-7");
  });
});

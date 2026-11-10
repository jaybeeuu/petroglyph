import { describe, expect, it } from "vitest";
import {
  stagedRecordSchema,
  type FileDeletedData,
  type FileStagedData,
  type StagedIndexStore,
  type StagedObjectStore,
  type StagedRecord,
} from "@petroglyph/staging-contracts";
import { applyDeleted, applyStaged } from "./index-apply.js";

/** In-memory index store — unit fixture matching the interface contract. */
function memStore(): StagedIndexStore & { records: StagedRecord[] } {
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
      const i = records.findIndex((r) => r.profileId === profileId && r.itemId === itemId);
      if (i >= 0) records.splice(i, 1);
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
      for (const r of doomed) {
        const i = records.indexOf(r);
        if (i >= 0) records.splice(i, 1);
      }
      return Promise.resolve();
    },
    queryFeed(options) {
      const start =
        options.cursor === undefined
          ? 0
          : records.findIndex((r) => r.itemId === options.cursor) + 1;
      const page = records.slice(
        start,
        options.limit === undefined ? undefined : start + options.limit,
      );
      const next = start + page.length < records.length ? page[page.length - 1]?.itemId : undefined;
      return Promise.resolve({
        records: page,
        ...(next === undefined ? {} : { nextCursor: next }),
      });
    },
  };
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

describe("applyStaged", () => {
  it("upserts the {profileId, itemId} record with the staged facts; redelivery never duplicates", async () => {
    const store = memStore();

    await applyStaged(store, staged, { createdAt: "2026-09-01T00:00:00.000Z" });
    await applyStaged(store, staged, { createdAt: "2026-09-01T00:00:00.000Z" });

    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      profileId: "p1",
      itemId: "item-1",
      s3Key: "staging/v1/p1/notes/a.pdf",
      relativePath: "notes",
      name: "a.pdf",
      source: "onedrive",
      mimeType: "application/pdf",
      status: "staged",
    });
  });

  it("writes the expiry aligned to the S3 lifecycle when ttlSeconds is configured", async () => {
    const store = memStore();

    await applyStaged(store, staged, {
      createdAt: "2026-09-01T00:00:00.000Z",
      ttlSeconds: 30 * 86400,
    });

    const createdAtEpoch = Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1000);
    expect(store.records[0]?.expiresAt).toBe(createdAtEpoch + 30 * 86400);
  });
});

describe("applyDeleted", () => {
  it("removes the record and deletes the object at the STORED key; re-delete is a no-op", async () => {
    const store = memStore();
    const { objectStore, deleteCalls } = objectStoreSpy();
    await applyStaged(store, staged, { createdAt: "2026-09-01T00:00:00.000Z" });

    await applyDeleted(store, objectStore, deletedItem);
    await applyDeleted(store, objectStore, deletedItem);

    expect(store.records).toHaveLength(0);
    expect(deleteCalls).toEqual(["staging/v1/p1/notes/a.pdf"]);
  });

  it("an event key never overrides the stored key, so a stale guess cannot orphan the object", async () => {
    const store = memStore();
    const { objectStore, deleteCalls } = objectStoreSpy();
    await applyStaged(store, staged, { createdAt: "2026-09-01T00:00:00.000Z" });

    await applyDeleted(store, objectStore, deletedStaleKey);

    expect(store.records).toHaveLength(0);
    expect(deleteCalls).toEqual(["staging/v1/p1/notes/a.pdf"]);
  });

  it("a null event s3Key still deletes the stored object, so removing the record never orphans it", async () => {
    const store = memStore();
    const { objectStore, deleteCalls } = objectStoreSpy();
    await applyStaged(store, staged, { createdAt: "2026-09-01T00:00:00.000Z" });

    await applyDeleted(store, objectStore, deletedNullKey);

    expect(store.records).toHaveLength(0);
    expect(deleteCalls).toEqual(["staging/v1/p1/notes/a.pdf"]);
  });

  it("a delete for a record that was never staged removes and deletes nothing", async () => {
    const store = memStore();
    const { objectStore, deleteCalls } = objectStoreSpy();

    await applyDeleted(store, objectStore, deletedItem);

    expect(store.records).toHaveLength(0);
    expect(deleteCalls).toEqual([]);
  });

  it("folder path-level delete: sweeps every record under the path and deletes their objects; repeat is a no-op", async () => {
    const store = memStore();
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
    store.records.push(recordFor(child), recordFor(deeper), recordFor(sibling));
    const { objectStore, deleteCalls } = objectStoreSpy();

    await applyDeleted(store, objectStore, deletedFolder);
    await applyDeleted(store, objectStore, deletedFolder);

    expect(store.records.map((r) => r.itemId)).toEqual(["sibling"]);
    expect(deleteCalls).toEqual([
      "staging/v1/p1/notes/sub/c.pdf",
      "staging/v1/p1/notes/sub/deep/d.pdf",
    ]);
  });

  // The accepted gap (petroglyph-9lcj, covered long term by petroglyph-1ey8):
  // a folder deletion with no path on the wire cannot sweep, so a child that
  // never arrives as its own delta item keeps its record until the row TTL.
  it("a path-less folder delete removes only its own record and leaves children in place", async () => {
    const store = memStore();
    const child = {
      ...staged2,
      itemId: "deep-item",
      name: "c.pdf",
      relativePath: "notes/sub",
      s3Key: "staging/v1/p1/notes/sub/c.pdf",
    };
    store.records.push(recordFor(child));
    const { objectStore, deleteCalls } = objectStoreSpy();

    await applyDeleted(store, objectStore, {
      profileId: "p1",
      source: "onedrive",
      changeType: "deleted",
      itemId: "folder-1",
    });

    expect(store.records.map((r) => r.itemId)).toEqual(["deep-item"]);
    expect(deleteCalls).toEqual([]);
  });
});

describe("queryFeed", () => {
  it("serves staged records only, ordered, cursor-paged without dups or gaps", async () => {
    const store = memStore();
    for (const data of [
      staged,
      staged2,
      { ...staged, itemId: "item-3", name: "c.pdf", s3Key: "staging/v1/p1/notes/c.pdf" },
    ]) {
      store.records.push(recordFor(data));
    }

    const page1 = await store.queryFeed({ profileId: "p1", limit: 2 });
    expect(page1.records.map((r) => r.itemId)).toEqual(["item-1", "item-2"]);
    const nextCursor = page1.nextCursor;
    const page2 = await store.queryFeed(
      nextCursor === undefined
        ? { profileId: "p1", limit: 2 }
        : { profileId: "p1", limit: 2, cursor: nextCursor },
    );
    expect(page2.records.map((r) => r.itemId)).toEqual(["item-3"]);
    expect(page2.nextCursor).toBeUndefined();
  });
});

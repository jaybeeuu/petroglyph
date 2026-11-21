import { describe, expect, it } from "vitest";
import type {
  FeedPage,
  StagedIndexStore,
  StagedObjectStore,
  StagedRecord,
} from "@petroglyph/staging-contracts";
import { purgeStagedStorageForProfile } from "./profile-purge.js";

function createStagedRecord(
  overrides: Partial<StagedRecord> & { profileId: string; itemId: string; s3Key: string },
): StagedRecord {
  return {
    relativePath: "notes",
    name: `${overrides.itemId}.pdf`,
    source: "onedrive",
    mimeType: "application/pdf",
    status: "staged",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * The two ports the purge writes through, over one shared operation log, so a
 * test can prove the order of the deletes as well as their result.
 */
interface PurgeFixture {
  index: StagedIndexStore;
  objectStore: StagedObjectStore;
  /** Every object and row delete the purge issued, in the order it issued them. */
  operations: string[];
  remainingRows: (profileId: string) => StagedRecord[];
  objectKeys: () => string[];
}

/**
 * The two ports the purge writes through, over one shared operation log, so a
 * test can prove the order of the deletes as well as their result.
 */
function createPurgeFixture(records: StagedRecord[], objectKeys: string[]): PurgeFixture {
  const rows = new Map(records.map((record) => [`${record.profileId}/${record.itemId}`, record]));
  const objects = new Set(objectKeys);
  const operations: string[] = [];

  const index: StagedIndexStore = {
    queryFeed: (query): Promise<FeedPage> => {
      const ordered = [...rows.values()]
        .filter((record) => record.profileId === query.profileId)
        .sort((left, right) => left.itemId.localeCompare(right.itemId));
      const cursor = query.cursor;
      const after =
        cursor === undefined ? ordered : ordered.filter((record) => record.itemId > cursor);
      const page = after.slice(0, query.limit);
      const nextCursor = after.length > page.length ? page[page.length - 1]?.itemId : undefined;
      return Promise.resolve({
        records: page,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      });
    },
    get: (profileId, itemId): Promise<StagedRecord | null> =>
      Promise.resolve(rows.get(`${profileId}/${itemId}`) ?? null),
    upsert: (record): Promise<void> => {
      rows.set(`${record.profileId}/${record.itemId}`, record);
      return Promise.resolve();
    },
    remove: (profileId, itemId): Promise<void> => {
      operations.push(`delete-row:${itemId}`);
      rows.delete(`${profileId}/${itemId}`);
      return Promise.resolve();
    },
    listUnderPath: (): Promise<StagedRecord[]> =>
      Promise.reject(new Error("the purge does not list under a path")),
    removeUnderPath: (): Promise<void> =>
      Promise.reject(new Error("the purge does not remove under a path")),
  };

  const objectStore: StagedObjectStore = {
    delete: (key): Promise<void> => {
      operations.push(`delete-object:${key}`);
      objects.delete(key);
      return Promise.resolve();
    },
    get: (): Promise<null> => Promise.resolve(null),
    put: (): Promise<never> => Promise.reject(new Error("the purge never writes an object")),
    presignGet: (): Promise<never> => Promise.reject(new Error("the purge never presigns")),
  };

  return {
    index,
    objectStore,
    operations,
    remainingRows: (profileId) =>
      [...rows.values()].filter((record) => record.profileId === profileId),
    objectKeys: () => [...objects],
  };
}

describe("purgeStagedStorageForProfile", () => {
  it("deletes every staged object and its row, object before row", async () => {
    const fixture = createPurgeFixture(
      [
        createStagedRecord({
          profileId: "p1",
          itemId: "item-1",
          s3Key: "staging/v1/p1/notes/item-1.pdf",
        }),
        createStagedRecord({
          profileId: "p1",
          itemId: "item-2",
          s3Key: "staging/v1/p1/reports/item-2.pdf",
        }),
      ],
      ["staging/v1/p1/notes/item-1.pdf", "staging/v1/p1/reports/item-2.pdf"],
    );

    const outcome = await purgeStagedStorageForProfile(fixture, "p1");

    expect(outcome).toEqual({ status: "complete" });
    expect(fixture.operations).toEqual([
      "delete-object:staging/v1/p1/notes/item-1.pdf",
      "delete-row:item-1",
      "delete-object:staging/v1/p1/reports/item-2.pdf",
      "delete-row:item-2",
    ]);
    expect(fixture.objectKeys()).toEqual([]);
    expect(fixture.remainingRows("p1")).toEqual([]);
  });

  it("leaves another profile's rows and objects alone", async () => {
    const keptObject = "staging/v1/p2/notes/item-1.pdf";
    const fixture = createPurgeFixture(
      [
        createStagedRecord({
          profileId: "p1",
          itemId: "item-1",
          s3Key: "staging/v1/p1/notes/item-1.pdf",
        }),
        createStagedRecord({ profileId: "p2", itemId: "item-1", s3Key: keptObject }),
      ],
      ["staging/v1/p1/notes/item-1.pdf", keptObject],
    );

    await purgeStagedStorageForProfile(fixture, "p1");

    expect(fixture.remainingRows("p2")).toHaveLength(1);
    expect(fixture.objectKeys()).toEqual([keptObject]);
    expect(fixture.operations).not.toContain(`delete-object:${keptObject}`);
  });

  it("never deletes a staged object whose key belongs to another profile's prefix", async () => {
    const foreignKey = "staging/v1/p2/notes/item-1.pdf";
    const fixture = createPurgeFixture(
      [createStagedRecord({ profileId: "p1", itemId: "item-1", s3Key: foreignKey })],
      [foreignKey],
    );

    await purgeStagedStorageForProfile(fixture, "p1");

    expect(fixture.operations).toEqual([]);
    expect(fixture.objectKeys()).toEqual([foreignKey]);
    expect(fixture.remainingRows("p1")).toHaveLength(1);
  });

  it("stops at the object budget and the next pass reaches zero", async () => {
    const keys = ["a", "b", "c"].map((name) => `staging/v1/p1/notes/${name}.pdf`);
    const fixture = createPurgeFixture(
      keys.map((s3Key, position) =>
        createStagedRecord({ profileId: "p1", itemId: `item-${position + 1}`, s3Key }),
      ),
      keys,
    );

    const firstPass = await purgeStagedStorageForProfile({ ...fixture, objectBudget: 2 }, "p1");

    expect(firstPass).toEqual({ status: "exhausted" });
    expect(fixture.remainingRows("p1")).toHaveLength(1);

    const secondPass = await purgeStagedStorageForProfile(fixture, "p1");

    expect(secondPass).toEqual({ status: "complete" });
    expect(fixture.remainingRows("p1")).toEqual([]);
    expect(fixture.objectKeys()).toEqual([]);
    // Each key was deleted exactly once across the two passes.
    const objectDeletes = fixture.operations.filter((operation) =>
      operation.startsWith("delete-object:"),
    );
    expect(objectDeletes).toHaveLength(3);
  });

  it("completes without writing when the profile has no staged rows", async () => {
    const fixture = createPurgeFixture([], []);

    const outcome = await purgeStagedStorageForProfile(fixture, "p1");

    expect(outcome).toEqual({ status: "complete" });
    expect(fixture.operations).toEqual([]);
  });
});

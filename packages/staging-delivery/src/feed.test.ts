import { describe, expect, it } from "vitest";
import type {
  StagedChange,
  StagedChangeLog,
  StagedIndexStore,
  StagedObjectStore,
  StagedRecord,
} from "@petroglyph/staging-contracts";
import {
  DEFAULT_PAGE_SIZE,
  buildFeed,
  buildPresignedDisposition,
  resolveOwnedEntry,
} from "./feed.js";

function createRecord(overrides: Partial<StagedRecord> = {}): StagedRecord {
  return {
    profileId: "p1",
    subscriptionId: "p1",
    itemId: "item-1",
    s3Key: "staging/v1/p1/notes/a.pdf",
    relativePath: "notes",
    name: "a.pdf",
    source: "onedrive",
    mimeType: "application/pdf",
    status: "staged",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function createChange(overrides: Partial<StagedChange> = {}): StagedChange {
  return {
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
    recordedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function changeLogSpy(changes: StagedChange[]): {
  changeLog: StagedChangeLog;
  queries: { profileId: string; after?: number; limit?: number }[];
} {
  const queries: { profileId: string; after?: number; limit?: number }[] = [];
  const changeLog = {
    append() {
      return Promise.resolve({ status: "appended" as const });
    },
    read(options: { profileId: string; after?: number; limit?: number }) {
      queries.push(options);
      return Promise.resolve(changes);
    },
  } as unknown as StagedChangeLog;
  return { changeLog, queries };
}

/** An index holding exactly these records, keyed by the item they describe. */
function indexSpy(records: StagedRecord[]): StagedIndexStore {
  return {
    get(profileId: string, itemId: string) {
      return Promise.resolve(
        records.find((record) => record.profileId === profileId && record.itemId === itemId) ??
          null,
      );
    },
  } as unknown as StagedIndexStore;
}

function presignSpy(): {
  objectStore: StagedObjectStore;
  calls: { key: string; ttlSeconds?: number; responseContentDisposition?: string }[];
} {
  const calls: { key: string; ttlSeconds?: number; responseContentDisposition?: string }[] = [];
  const objectStore = {
    presignGet(
      key: string,
      options?: { ttlSeconds?: number; responseContentDisposition?: string },
    ) {
      calls.push({ key, ...options });
      return Promise.resolve(`https://presigned.example/${key}?x=sig`);
    },
  } as unknown as StagedObjectStore;
  return { objectStore, calls };
}

function decodeCursor(token: string): { profileId: string; seq: number } {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
    profileId: string;
    seq: number;
  };
}

describe("buildFeed", () => {
  it("serves the current record of each staged change with a presigned URL from the STORED key", async () => {
    const { changeLog } = changeLogSpy([createChange()]);
    const { objectStore, calls } = presignSpy();

    const result = await buildFeed({
      changeLog,
      index: indexSpy([createRecord()]),
      objectStore,
      profileId: "p1",
    });

    expect(result.files).toEqual([
      {
        itemId: "item-1",
        name: "a.pdf",
        relativePath: "notes",
        mimeType: "application/pdf",
        createdAt: "2026-09-01T00:00:00.000Z",
        s3PresignedUrl: "https://presigned.example/staging/v1/p1/notes/a.pdf?x=sig",
      },
    ]);
    expect(calls).toEqual([
      {
        key: "staging/v1/p1/notes/a.pdf",
        ttlSeconds: 900,
        responseContentDisposition: "attachment; filename*=UTF-8''a.pdf",
      },
    ]);
  });

  it("asks the log for rows after the cursor, ordered by seq, at the page limit", async () => {
    const { changeLog, queries } = changeLogSpy([createChange({ seq: 8 })]);
    const { objectStore } = presignSpy();

    const result = await buildFeed({
      changeLog,
      index: indexSpy([createRecord()]),
      objectStore,
      profileId: "p1",
      after: 7,
      limit: 3,
    });

    expect(queries).toEqual([{ profileId: "p1", after: 7, limit: 3 }]);
    expect(decodeCursor(result.nextToken ?? "")).toEqual({ profileId: "p1", seq: 8 });
  });

  it("reports no next token when the log has nothing after the cursor", async () => {
    const { changeLog, queries } = changeLogSpy([]);
    const { objectStore } = presignSpy();

    const result = await buildFeed({
      changeLog,
      index: indexSpy([createRecord()]),
      objectStore,
      profileId: "p1",
      after: 7,
    });

    expect(queries).toEqual([{ profileId: "p1", after: 7, limit: DEFAULT_PAGE_SIZE }]);
    expect(result.files).toEqual([]);
    expect(result.nextToken).toBeNull();
  });

  it("advances the cursor past delete rows without serving them", async () => {
    const { changeLog } = changeLogSpy([
      createChange({ seq: 4, changeId: "p1:item-1:deleted:", kind: "delete" }),
    ]);
    const { objectStore, calls } = presignSpy();

    const result = await buildFeed({
      changeLog,
      index: indexSpy([createRecord()]),
      objectStore,
      profileId: "p1",
    });

    expect(result.files).toEqual([]);
    expect(calls).toEqual([]);
    expect(decodeCursor(result.nextToken ?? "")).toEqual({ profileId: "p1", seq: 4 });
  });

  it("never serves a stage row whose record has been deleted", async () => {
    const { changeLog } = changeLogSpy([createChange()]);
    const { objectStore, calls } = presignSpy();

    const result = await buildFeed({
      changeLog,
      index: indexSpy([]),
      objectStore,
      profileId: "p1",
    });

    expect(result.files).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("serves one item once when a page carries two stages of it", async () => {
    const { changeLog } = changeLogSpy([
      createChange({ seq: 1, changeId: "p1:item-1:file:etag-1" }),
      createChange({ seq: 2, changeId: "p1:item-1:file:etag-2", eTag: "etag-2" }),
    ]);
    const { objectStore, calls } = presignSpy();

    const result = await buildFeed({
      changeLog,
      index: indexSpy([createRecord()]),
      objectStore,
      profileId: "p1",
    });

    expect(result.files.map((file) => file.itemId)).toEqual(["item-1"]);
    expect(calls).toHaveLength(1);
    expect(decodeCursor(result.nextToken ?? "")).toEqual({ profileId: "p1", seq: 2 });
  });
});

describe("resolveOwnedEntry", () => {
  it("presigns a record read from the index for an owned profile", async () => {
    const { objectStore, calls } = presignSpy();

    const entry = await resolveOwnedEntry({
      index: indexSpy([createRecord()]),
      objectStore,
      profileIds: ["p1"],
      itemId: "item-1",
    });

    expect(entry).toMatchObject({ itemId: "item-1", name: "a.pdf" });
    expect(calls).toEqual([
      {
        key: "staging/v1/p1/notes/a.pdf",
        ttlSeconds: 900,
        responseContentDisposition: "attachment; filename*=UTF-8''a.pdf",
      },
    ]);
  });

  it("resolves to null when no owned profile holds the item", async () => {
    const { objectStore } = presignSpy();

    const entry = await resolveOwnedEntry({
      index: indexSpy([]),
      objectStore,
      profileIds: ["p1"],
      itemId: "item-1",
    });

    expect(entry).toBeNull();
  });
});

describe("buildPresignedDisposition", () => {
  it("percent-encodes filename characters that are invalid RFC 5987 attr-chars", () => {
    expect(buildPresignedDisposition("a(b)*'.pdf")).toBe(
      "attachment; filename*=UTF-8''a%28b%29%2A%27.pdf",
    );
  });

  it("encodes the filename for a Content-Disposition attachment override", () => {
    expect(buildPresignedDisposition("a b.pdf")).toBe("attachment; filename*=UTF-8''a%20b.pdf");
  });
});

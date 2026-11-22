import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SyncProfile } from "@petroglyph/core";
import type {
  FeedPage,
  StagedIndexStore,
  StagedObjectStore,
  StagedRecord,
} from "@petroglyph/staging-contracts";
import { createFilesRouter, type FilesRouterVariables } from "./app.js";
import { encodeFeedCursor } from "./cursor.js";

/** A profile the caller owns, with only the fields a delivery test cares about set. */
function createProfile(overrides: Partial<SyncProfile> = {}): SyncProfile {
  return {
    profileId: "p1",
    userId: "user-1",
    name: "Main",
    sourceFolderPath: "notes",
    pollingIntervalMinutes: 5,
    enabled: true,
    active: true,
    initialSyncEnabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const stagedRecord: StagedRecord = {
  profileId: "p1",
  itemId: "item-1",
  s3Key: "staging/v1/p1/notes/a.pdf",
  relativePath: "notes",
  name: "a.pdf",
  source: "onedrive",
  mimeType: "application/pdf",
  status: "staged",
  createdAt: "2026-09-01T00:00:00.000Z",
};

class MemoryIndex implements StagedIndexStore {
  readonly records = new Map<string, StagedRecord>();

  put(record: StagedRecord): void {
    this.records.set(`${record.profileId}\u0000${record.itemId}`, { ...record });
  }

  private key(profileId: string, itemId: string): string {
    return `${profileId}\u0000${itemId}`;
  }

  upsert(record: StagedRecord): Promise<void> {
    this.put(record);
    return Promise.resolve();
  }

  get(profileId: string, itemId: string): Promise<StagedRecord | null> {
    return Promise.resolve(this.records.get(this.key(profileId, itemId)) ?? null);
  }

  remove(profileId: string, itemId: string): Promise<void> {
    this.records.delete(this.key(profileId, itemId));
    return Promise.resolve();
  }

  listUnderPath(profileId: string, path: string): Promise<StagedRecord[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (r) =>
          r.profileId === profileId &&
          (r.relativePath === path || r.relativePath.startsWith(`${path}/`)),
      ),
    );
  }

  async removeUnderPath(profileId: string, path: string): Promise<void> {
    for (const record of await this.listUnderPath(profileId, path)) {
      this.records.delete(this.key(profileId, record.itemId));
    }
  }
  queryFeed(options: { profileId: string; limit?: number; cursor?: string }): Promise<FeedPage> {
    const sorted = [...this.records.values()]
      .filter((r) => r.profileId === options.profileId)
      .sort((left, right) => left.itemId.localeCompare(right.itemId));
    const start =
      options.cursor === undefined ? 0 : sorted.findIndex((r) => r.itemId === options.cursor) + 1;
    const limit = options.limit ?? 1000;
    const records = sorted.slice(start, start + limit);
    // DDB semantics: LastEvaluatedKey is the last RETURNED key; the next
    // page resumes exclusively after it.
    const lastReturned = sorted[start + limit - 1];
    return Promise.resolve(
      lastReturned === undefined ? { records } : { records, nextCursor: lastReturned.itemId },
    );
  }
}

function objectStoreSpy(): {
  objectStore: StagedObjectStore;
  presigned: { key: string }[];
} {
  const presigned: { key: string }[] = [];
  return {
    presigned,
    objectStore: {
      presignGet(key: string) {
        presigned.push({ key });
        return Promise.resolve(`https://presigned.example/${key}`);
      },
    } as unknown as StagedObjectStore,
  };
}

function buildApp(options: {
  profiles: SyncProfile[];
  index: StagedIndexStore;
  objectStore: StagedObjectStore;
}): { app: Hono<{ Variables: FilesRouterVariables }>; readProfile: ReturnType<typeof vi.fn> } {
  const readProfile = vi.fn((userId: string, profileId: string) => {
    const found = options.profiles.find(
      (candidate) => candidate.userId === userId && candidate.profileId === profileId,
    );
    return Promise.resolve(found === undefined ? null : { ...found });
  });
  const app = new Hono<{ Variables: FilesRouterVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route(
    "/",
    createFilesRouter({ index: options.index, objectStore: options.objectStore, readProfile }),
  );
  return { app, readProfile };
}

describe("GET /profiles/:id/files feed", () => {
  it("answers 500 instead of a page that violates the contract the operation declares", async () => {
    const index = new MemoryIndex();
    // The feed entry schema requires a non-empty name, so this page is one the
    // registry forbids; in `report` mode it fails the run instead of shipping.
    index.put({ ...stagedRecord, name: "" });
    const { app } = buildApp({
      profiles: [createProfile()],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/profiles/p1/files");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "response_contract_mismatch" } });
  });

  it("serves the profile named in the path, not a profile found by a flag", async () => {
    const index = new MemoryIndex();
    index.put({ ...stagedRecord, profileId: "p1", itemId: "item-1" });
    index.put({ ...stagedRecord, profileId: "p2", itemId: "item-2" });
    const { app, readProfile } = buildApp({
      profiles: [createProfile({ profileId: "p1" }), createProfile({ profileId: "p2" })],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/profiles/p2/files");
    const body = (await res.json()) as { files: { itemId: string }[] };

    expect(res.status).toBe(200);
    expect(body.files.map((file) => file.itemId)).toEqual(["item-2"]);
    expect(readProfile).toHaveBeenCalledWith("user-1", "p2");
  });

  it("answers 404 for a profile the caller does not own, and lists nothing from any other", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { app } = buildApp({
      profiles: [createProfile()],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/profiles/unknown-profile/files");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Profile not found" });
  });

  it("answers 410 with a branchable code once the profile is soft-deleted", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { app } = buildApp({
      profiles: [createProfile({ deletedAt: "2026-11-21T00:00:00.000Z" })],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/profiles/p1/files");

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: { code: "profile_deleted" } });
  });

  it("answers 410 for a deleted profile before it validates the query", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { app } = buildApp({
      profiles: [createProfile({ deletedAt: "2026-11-21T00:00:00.000Z" })],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const badLimit = await app.request("/profiles/p1/files?limit=0");
    const emptyCursor = await app.request("/profiles/p1/files?nextToken=");

    // The profile answers first: a 400 for the query would let the client clear
    // and persist its cursor before it ever reads the 410 that stops it.
    expect(badLimit.status).toBe(410);
    expect(emptyCursor.status).toBe(410);
  });

  it("serves an empty feed when the named profile is disabled", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { app } = buildApp({
      profiles: [createProfile({ enabled: false })],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/profiles/p1/files");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [], nextToken: null });
  });

  it("pages a profile's staged records with the cursor the response returned", async () => {
    const index = new MemoryIndex();
    index.put({ ...stagedRecord, itemId: "item-1" });
    index.put({ ...stagedRecord, itemId: "item-2" });
    const { app } = buildApp({
      profiles: [createProfile()],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/profiles/p1/files?limit=1");
    const body = (await res.json()) as { files: { itemId: string }[]; nextToken: string | null };
    expect(res.status).toBe(200);
    expect(body.files.map((f) => f.itemId)).toEqual(["item-1"]);
    expect(body.nextToken).not.toBeNull();

    // The feed reflects the index at read time: a new record appears on the next page.
    index.put({ ...stagedRecord, itemId: "item-3" });
    const next = await app.request(
      `/profiles/p1/files?nextToken=${encodeURIComponent(body.nextToken ?? "")}&limit=2`,
    );
    const nextBody = (await next.json()) as {
      files: { itemId: string }[];
      nextToken: string | null;
    };
    expect(nextBody.files.map((f) => f.itemId)).toEqual(["item-2", "item-3"]);
  });

  it("rejects a parameter the feed does not declare, instead of restarting at page 1", async () => {
    const index = new MemoryIndex();
    index.put({ ...stagedRecord, itemId: "item-1" });
    const { app } = buildApp({
      profiles: [createProfile()],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    // `after` is the name this surface used to take: it must be loud now, not stripped.
    const cursor = encodeFeedCursor({ profileId: "p1", itemId: "item-1" });
    const res = await app.request(`/profiles/p1/files?after=${encodeURIComponent(cursor)}`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid files query: after is not a supported parameter",
    });
  });

  it("rejects a cursor bound to a profile other than the one in the path", async () => {
    const index = new MemoryIndex();
    index.put({ ...stagedRecord, profileId: "p2" });
    const { app } = buildApp({
      profiles: [createProfile({ profileId: "p1" }), createProfile({ profileId: "p2" })],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const foreign = encodeFeedCursor({ profileId: "p2", itemId: "item-1" });
    const res = await app.request(`/profiles/p1/files?nextToken=${encodeURIComponent(foreign)}`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid files cursor" });
  });

  it("names the field and its constraint when the feed query is invalid", async () => {
    const { app } = buildApp({
      profiles: [createProfile()],
      index: new MemoryIndex(),
      objectStore: objectStoreSpy().objectStore,
    });

    const limit = await app.request("/profiles/p1/files?limit=0");
    expect(limit.status).toBe(400);
    expect(await limit.json()).toEqual({
      error: "Invalid files query: limit must be an integer between 1 and 100",
    });

    const cursor = await app.request("/profiles/p1/files?nextToken=");
    expect(cursor.status).toBe(400);
    expect(await cursor.json()).toEqual({
      error: "Invalid files query: nextToken must be a non-empty string",
    });

    expect((await app.request("/profiles/p1/files?nextToken=not-a-cursor")).status).toBe(400);
    expect((await app.request("/profiles/p1/files?limit=abc")).status).toBe(400);
  });
});

describe("GET /profiles/:id/files/:itemId download", () => {
  it("resolves an owned staged record to a presigned entry", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { objectStore, presigned } = objectStoreSpy();
    const { app } = buildApp({ profiles: [createProfile()], index, objectStore });

    const res = await app.request("/profiles/p1/files/item-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      itemId: "item-1",
      name: "a.pdf",
      s3PresignedUrl: "https://presigned.example/staging/v1/p1/notes/a.pdf",
    });
    expect(presigned).toEqual([{ key: "staging/v1/p1/notes/a.pdf" }]);
  });

  it("resolves the item under the profile named in the path when two share an itemId", async () => {
    const index = new MemoryIndex();
    index.put({ ...stagedRecord, profileId: "p2", s3Key: "staging/v1/p2/notes/a.pdf" });
    index.put({ ...stagedRecord, profileId: "p1", s3Key: "staging/v1/p1/notes/a.pdf" });
    const { objectStore, presigned } = objectStoreSpy();
    const { app } = buildApp({
      profiles: [createProfile({ profileId: "p2" }), createProfile({ profileId: "p1" })],
      index,
      objectStore,
    });

    const res = await app.request("/profiles/p1/files/item-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      s3PresignedUrl: "https://presigned.example/staging/v1/p1/notes/a.pdf",
    });
    expect(presigned).toEqual([{ key: "staging/v1/p1/notes/a.pdf" }]);
  });

  it("answers 404 for a record another profile owns, or one that is gone", async () => {
    const index = new MemoryIndex();
    index.put({ ...stagedRecord, profileId: "p-other" });
    const { app } = buildApp({
      profiles: [createProfile()],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    expect((await app.request("/profiles/p1/files/item-1")).status).toBe(404);

    index.put(stagedRecord);
    await index.remove("p1", "item-1");
    expect((await app.request("/profiles/p1/files/item-1")).status).toBe(404);
  });

  it("answers 404 for a profile the caller does not own", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { app } = buildApp({
      profiles: [createProfile()],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/profiles/unknown-profile/files/item-1");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File not found" });
  });

  it("answers 410 once the profile is soft-deleted", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { app } = buildApp({
      profiles: [createProfile({ deletedAt: "2026-11-21T00:00:00.000Z" })],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/profiles/p1/files/item-1");

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: { code: "profile_deleted" } });
  });

  it("answers 404 when the named profile is disabled", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { app } = buildApp({
      profiles: [createProfile({ enabled: false })],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/profiles/p1/files/item-1");

    expect(res.status).toBe(404);
  });
});

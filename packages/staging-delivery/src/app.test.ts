import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ObjectStore, SyncProfile } from "@petroglyph/core";
import type { FeedPage, StagedIndexStore, StagedRecord } from "@petroglyph/staging-consumer";
import { createFilesRouter, type FilesRouterVariables } from "./app.js";
import { encodeFeedCursor } from "./cursor.js";

const baseProfile: SyncProfile = {
  profileId: "p1",
  userId: "user-1",
  name: "Main",
  sourceFolderPath: "notes",
  destinationVaultPath: "Inbox",
  pollingIntervalMinutes: 5,
  enabled: true,
  active: true,
  initialSyncEnabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function profile(overrides: Partial<SyncProfile> = {}): SyncProfile {
  return { ...baseProfile, ...overrides };
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
  objectStore: ObjectStore;
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
    } as unknown as ObjectStore,
  };
}

function buildApp(options: {
  profiles: SyncProfile[];
  index: MemoryIndex;
  objectStore: ObjectStore;
}): { app: Hono<{ Variables: FilesRouterVariables }>; listProfiles: ReturnType<typeof vi.fn> } {
  const listProfiles = vi.fn().mockResolvedValue(options.profiles.map((p) => ({ ...p })));
  const app = new Hono<{ Variables: FilesRouterVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route(
    "/",
    createFilesRouter({ index: options.index, objectStore: options.objectStore, listProfiles }),
  );
  return { app, listProfiles };
}

describe("GET /files feed", () => {
  it("returns an empty feed when the user has no active profile (M8 read-back)", async () => {
    const { app } = buildApp({
      profiles: [profile({ active: false })],
      index: new MemoryIndex(),
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/files");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [], nextToken: null });
  });

  it("returns an empty feed when the active profile is not sync-enabled (M8, read-only)", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { app, listProfiles } = buildApp({
      profiles: [Object.freeze(profile({ enabled: false }))],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/files");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [], nextToken: null });
    // READ-ONLY: the record was read back as-is; the profile record was never written.
    expect(index.records.size).toBe(1);
    expect(listProfiles).toHaveBeenCalledWith("user-1");
  });

  it("serves the active profile's staged records with cursor paging (M1, M7 monitor semantics)", async () => {
    const index = new MemoryIndex();
    index.put({ ...stagedRecord, itemId: "item-1" });
    index.put({ ...stagedRecord, itemId: "item-2" });
    const { app } = buildApp({
      profiles: [profile()],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/files?limit=1");
    const body = (await res.json()) as { files: { itemId: string }[]; nextToken: string | null };
    expect(res.status).toBe(200);
    expect(body.files.map((f) => f.itemId)).toEqual(["item-1"]);
    expect(body.nextToken).not.toBeNull();

    // The feed reflects the index at read time: a new record appears on the next page.
    index.put({ ...stagedRecord, itemId: "item-3" });
    const next = await app.request(
      `/files?after=${encodeURIComponent(body.nextToken ?? "")}&limit=2`,
    );
    const nextBody = (await next.json()) as {
      files: { itemId: string }[];
      nextToken: string | null;
    };
    expect(nextBody.files.map((f) => f.itemId)).toEqual(["item-2", "item-3"]);
  });

  it("rejects a cursor bound to a profile the user does not own (auth scoping)", async () => {
    const { app } = buildApp({
      profiles: [profile()],
      index: new MemoryIndex(),
      objectStore: objectStoreSpy().objectStore,
    });

    const foreign = encodeFeedCursor({ profileId: "p9", itemId: "item-1" });
    const res = await app.request(`/files?after=${encodeURIComponent(foreign)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid files cursor" });
  });

  it("rejects a malformed cursor and an out-of-range limit", async () => {
    const { app } = buildApp({
      profiles: [profile()],
      index: new MemoryIndex(),
      objectStore: objectStoreSpy().objectStore,
    });

    expect((await app.request("/files?after=not-a-cursor")).status).toBe(400);
    expect((await app.request("/files?limit=0")).status).toBe(400);
    expect((await app.request("/files?limit=101")).status).toBe(400);
    expect((await app.request("/files?limit=abc")).status).toBe(400);
  });
});

describe("GET /files/:itemId download", () => {
  it("resolves an owned staged record to a presigned entry (M5)", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { objectStore, presigned } = objectStoreSpy();
    const { app } = buildApp({ profiles: [profile()], index, objectStore });

    const res = await app.request("/files/item-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      itemId: "item-1",
      name: "a.pdf",
      s3PresignedUrl: "https://presigned.example/staging/v1/p1/notes/a.pdf",
    });
    expect(presigned).toEqual([{ key: "staging/v1/p1/notes/a.pdf" }]);
  });

  it("returns 404 when the record belongs to another user's profile (M5)", async () => {
    const index = new MemoryIndex();
    index.put({ ...stagedRecord, profileId: "p-other" });
    const { app } = buildApp({
      profiles: [profile()],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/files/item-1");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a deleted record and for an unknown user (M2, M6)", async () => {
    const index = new MemoryIndex();
    index.put(stagedRecord);
    const { app } = buildApp({
      profiles: [profile()],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    expect((await app.request("/files/missing-item")).status).toBe(404);

    await index.remove("p1", "item-1");
    expect((await app.request("/files/item-1")).status).toBe(404);

    const noProfiles = buildApp({ profiles: [], index, objectStore: objectStoreSpy().objectStore });
    expect((await noProfiles.app.request("/files/item-1")).status).toBe(404);
  });

  it("serves a record under any owned profile, active or not (own-records-only scope)", async () => {
    const index = new MemoryIndex();
    index.put({ ...stagedRecord, profileId: "p2" });
    const { app } = buildApp({
      profiles: [profile(), profile({ profileId: "p2", active: false })],
      index,
      objectStore: objectStoreSpy().objectStore,
    });

    const res = await app.request("/files/item-1");
    expect(res.status).toBe(200);
  });
});

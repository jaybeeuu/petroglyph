import { describe, expect, it } from "vitest";
import { normalizeRelativePath, walkDelta } from "./delta-walk.js";
import type { DeltaState, DeltaStateStore } from "./delta-state-store.js";
import type { GraphClient } from "../tokens/graph-client.js";

const INITIAL_URL =
  "https://graph.microsoft.com/v1.0/me/drive/root/delta?$select=id,name,parentReference,file,folder,deleted";

const state: DeltaState = {
  deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=opaque-abc",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const profile = { profileId: "p1", rootPath: "notes" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function memStateStore(initial: DeltaState | null = null): DeltaStateStore & {
  current: DeltaState | null;
  writes: number;
  clears: number;
} {
  const store = {
    current: initial,
    writes: 0,
    clears: 0,
    async read() {
      return Promise.resolve(store.current);
    },
    write(_userId: string, _provider: string, next: DeltaState) {
      store.writes += 1;
      store.current = next;
      return Promise.resolve();
    },
    clear() {
      store.clears += 1;
      store.current = null;
      return Promise.resolve();
    },
  };
  return store;
}

function scriptedClient(responses: (() => Response)[]): {
  client: GraphClient;
  paths: string[];
} {
  const paths: string[] = [];
  const client: GraphClient = {
    request(path) {
      paths.push(path);
      const next = responses.shift();
      if (next === undefined) {
        return Promise.resolve(jsonResponse({ value: [] }));
      }
      return Promise.resolve(next());
    },
  };
  return { client, paths };
}

function page(items: unknown[], links?: { nextLink?: string; deltaLink?: string }): Response {
  const body: { [key: string]: unknown } = { value: items };
  if (links?.nextLink !== undefined) {
    body["@odata.nextLink"] = links.nextLink;
  }
  if (links?.deltaLink !== undefined) {
    body["@odata.deltaLink"] = links.deltaLink;
  }
  return jsonResponse(body);
}

const fileItem = (overrides: { [key: string]: unknown }): { [key: string]: unknown } => ({
  id: "item-1",
  name: "notes/a.pdf",
  parentReference: { driveId: "drive-1", path: "/drive/root:/notes" },
  file: { mimeType: "application/pdf" },
  ...overrides,
});

describe("normalizeRelativePath", () => {
  it("distinguishes a drive-root path from an unknown path", () => {
    expect(normalizeRelativePath("/drive/root:")).toBe("");
    expect(normalizeRelativePath("/drive/root:/")).toBe("");
    expect(normalizeRelativePath("/drive/root:/notes")).toBe("notes");
    expect(normalizeRelativePath(undefined)).toBeUndefined();
    expect(normalizeRelativePath("not-a-drive-root-path")).toBeUndefined();
  });
});

describe("walkDelta", () => {
  it("full enumeration on first run: pages the nextLink chain and classifies created files", async () => {
    const store = memStateStore(null);
    const { client, paths } = scriptedClient([
      () =>
        page([fileItem({ id: "i1", name: "a.pdf" })], {
          nextLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=p1",
        }),
      () =>
        page([fileItem({ id: "i2", name: "b.pdf" })], {
          deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=final",
        }),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(paths).toEqual([
      INITIAL_URL,
      "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=p1",
    ]);
    expect(result.outcome).toBe("continued");
    expect(result.deltaLink).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=final",
    );
    expect(result.events).toMatchObject([
      {
        kind: "file",
        profileId: "p1",
        itemId: "i1",
        name: "a.pdf",
        relativePath: "notes",
        mimeType: "application/pdf",
      },
      {
        kind: "file",
        profileId: "p1",
        itemId: "i2",
        name: "b.pdf",
        relativePath: "notes",
        mimeType: "application/pdf",
      },
    ]);
  });

  it("incremental walk uses the stored deltaLink URL verbatim — never re-appends query params", async () => {
    const store = memStateStore(state);
    const { client, paths } = scriptedClient([() => page([], { deltaLink: state.deltaLink })]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(paths).toEqual([state.deltaLink]);
    expect(result.outcome).toBe("continued");
  });

  it("drains to the terminal deltaLink and persists it only on successful completion", async () => {
    const store = memStateStore(null);
    const { client } = scriptedClient([
      () =>
        page([fileItem({ id: "i1", name: "a.pdf" })], {
          nextLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=p1",
        }),
      () =>
        page([], { deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=done" }),
    ]);

    await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(store.writes).toBe(1);
    expect(store.current?.deltaLink).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=done",
    );
  });

  it("mid-run failure persists nothing — the last complete token stays authoritative", async () => {
    const store = memStateStore(state);
    const { client } = scriptedClient([
      () =>
        page([fileItem({ id: "i1", name: "a.pdf" })], {
          nextLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=p1",
        }),
      () => jsonResponse({ error: { code: "serviceUnavailable" } }, 503),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.outcome).toBe("failed");
    expect(store.writes).toBe(0);
    expect(store.current?.deltaLink).toBe(state.deltaLink);
  });

  it("maps deleted:{} file facets to deleted events with the normalized path", async () => {
    const store = memStateStore(state);
    const { client } = scriptedClient([
      () =>
        page(
          [
            {
              id: "gone-1",
              deleted: {},
              name: "a.pdf",
              parentReference: { path: "/drive/root:/notes" },
            },
          ],
          { deltaLink: state.deltaLink },
        ),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.outcome).toBe("continued");
    expect(result.events).toMatchObject([
      {
        kind: "deleted",
        profileId: "p1",
        itemId: "gone-1",
        name: "a.pdf",
        relativePath: "notes",
        isFolder: false,
      },
    ]);
  });

  it("a deleted folder carrying both folder and deleted facets classifies as deleted, not folder", async () => {
    const store = memStateStore(state);
    const { client } = scriptedClient([
      () =>
        page(
          [
            {
              id: "folder-1",
              deleted: {},
              folder: {},
              name: "sub",
              parentReference: { path: "/drive/root:/notes" },
            },
          ],
          { deltaLink: state.deltaLink },
        ),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.events).toMatchObject([
      {
        kind: "deleted",
        profileId: "p1",
        itemId: "folder-1",
        name: "sub",
        relativePath: "notes",
        isFolder: true,
      },
    ]);
  });

  it("does not substitute the item id for a deleted item whose name is omitted", async () => {
    const store = memStateStore(state);
    const { client } = scriptedClient([
      () =>
        page([{ id: "gone-1", deleted: {}, parentReference: { path: "/drive/root:/notes" } }], {
          deltaLink: state.deltaLink,
        }),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.events).toMatchObject([
      { kind: "deleted", profileId: "p1", itemId: "gone-1", relativePath: "notes" },
    ]);
    expect(result.events[0]?.name).toBeUndefined();
  });

  it("410 Gone resets: clears the stored token, re-enumerates from scratch, outcome reset", async () => {
    const store = memStateStore(state);
    const { client, paths } = scriptedClient([
      () => jsonResponse({ error: { code: "itemNotFound" } }, 410),
      () =>
        page([fileItem({ id: "i1", name: "a.pdf" })], {
          deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=fresh",
        }),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.outcome).toBe("reset");
    expect(result.events.length).toBe(1);
    expect(store.clears).toBe(1);
    expect(paths).toEqual([state.deltaLink, INITIAL_URL]);
    expect(store.current?.deltaLink).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=fresh",
    );
  });

  it("syncStateNotFound (40x) resets the same way, but other 5xx surfaces failed", async () => {
    const syncStore = memStateStore(state);
    const { client: syncClient } = scriptedClient([
      () => jsonResponse({ error: { code: "syncStateNotFound" } }, 400),
      () =>
        page([], { deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=fresh" }),
    ]);
    const syncResult = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client: syncClient,
      store: syncStore,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });
    expect(syncResult.outcome).toBe("reset");
    expect(syncStore.clears).toBe(1);

    const errStore = memStateStore(state);
    const { client: errClient } = scriptedClient([
      () => jsonResponse({ error: { code: "serviceUnavailable" } }, 503),
    ]);
    const errResult = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client: errClient,
      store: errStore,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });
    expect(errResult.outcome).toBe("failed");
    expect(errStore.clears).toBe(0);
  });

  it("normalizes OneDrive parentReference paths — the format never leaks past the walk", async () => {
    const store = memStateStore(null);
    const { client } = scriptedClient([
      () =>
        page(
          [
            fileItem({
              id: "i1",
              name: "a.pdf",
              parentReference: { path: "/drive/root:/notes/sub/deep" },
            }),
          ],
          { deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=final" },
        ),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.events[0]).toMatchObject({ relativePath: "notes/sub/deep" });
  });

  it("filters items outside the profile root path and routes items to their profile", async () => {
    const store = memStateStore(null);
    const { client } = scriptedClient([
      () =>
        page(
          [
            fileItem({
              id: "inside",
              name: "a.pdf",
              parentReference: { path: "/drive/root:/notes" },
            }),
            fileItem({
              id: "outside",
              name: "x.pdf",
              parentReference: { path: "/drive/root:/other" },
            }),
          ],
          { deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=final" },
        ),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile, { profileId: "p2", rootPath: "other" }],
      initialUrl: INITIAL_URL,
    });

    expect(result.events.map((event) => [event.profileId, event.itemId])).toEqual([
      ["p1", "inside"],
      ["p2", "outside"],
    ]);
  });

  it("tolerates a parentReference without path: the page parses and the unresolved item is surfaced, not dropped", async () => {
    const store = memStateStore(state);
    const { client } = scriptedClient([
      () =>
        page(
          [
            {
              id: "no-path-1",
              name: "a.pdf",
              parentReference: { driveId: "drive-1" },
              file: { mimeType: "application/pdf" },
            },
          ],
          { deltaLink: state.deltaLink },
        ),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.unresolvedPathCount).toBe(1);
    expect(result.events).toHaveLength(0);
    expect(result.outcome).toBe("failed");
    expect(store.writes).toBe(0);
  });

  it("tolerates an absent parentReference: the page parses and the unresolved item is surfaced, not dropped", async () => {
    const store = memStateStore(state);
    const { client } = scriptedClient([
      () =>
        page([{ id: "no-parent-1", name: "a.pdf", file: { mimeType: "application/pdf" } }], {
          deltaLink: state.deltaLink,
        }),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.unresolvedPathCount).toBe(1);
    expect(result.events).toHaveLength(0);
    expect(result.outcome).toBe("failed");
    expect(store.writes).toBe(0);
  });

  it("routes changes to a '/'-rooted profile instead of silently dropping every item", async () => {
    const store = memStateStore(state);
    const { client } = scriptedClient([
      () =>
        page(
          [fileItem({ id: "i1", name: "a.pdf", parentReference: { path: "/drive/root:/notes" } })],
          { deltaLink: state.deltaLink },
        ),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [{ profileId: "root", rootPath: "/" }],
      initialUrl: INITIAL_URL,
    });

    expect(result.outcome).toBe("continued");
    expect(result.events).toMatchObject([
      { profileId: "root", itemId: "i1", relativePath: "notes" },
    ]);
  });

  it("counts a drive-root item rather than emitting an empty relativePath or failing the walk", async () => {
    const store = memStateStore(state);
    const { client } = scriptedClient([
      () =>
        page(
          [fileItem({ id: "root-1", name: "a.pdf", parentReference: { path: "/drive/root:" } })],
          { deltaLink: state.deltaLink },
        ),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [{ profileId: "root", rootPath: "/" }],
      initialUrl: INITIAL_URL,
    });

    expect(result.outcome).toBe("continued");
    expect(result.events).toHaveLength(0);
    expect(result.driveRootItemCount).toBe(1);
    expect(store.writes).toBe(1);
  });

  it("does not emit created/updated events for folder items (gate is file-only)", async () => {
    const store = memStateStore(null);
    const { client } = scriptedClient([
      () =>
        page(
          [
            {
              id: "folder-1",
              folder: {},
              name: "sub",
              parentReference: { path: "/drive/root:/notes" },
            },
          ],
          { deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=final" },
        ),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.events).toHaveLength(0);
  });

  it("classifies a file item with no mimeType instead of rejecting the whole page", async () => {
    const store = memStateStore(null);
    const { client } = scriptedClient([
      () =>
        page([fileItem({ id: "i1", name: "a.unknown", file: {} })], {
          deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=final",
        }),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.outcome).toBe("continued");
    expect(result.events).toMatchObject([
      { kind: "file", itemId: "i1", name: "a.unknown", relativePath: "notes" },
    ]);
    expect(result.events[0]).not.toHaveProperty("mimeType");
  });

  it("carries the file facet eTag through as the version dimension", async () => {
    const store = memStateStore(null);
    const { client } = scriptedClient([
      () =>
        page(
          [
            fileItem({
              id: "i1",
              name: "a.pdf",
              file: { mimeType: "application/pdf", eTag: "etag-1" },
            }),
          ],
          { deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=final" },
        ),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.events[0]).toMatchObject({ kind: "file", eTag: "etag-1" });
  });

  it("keeps only the last occurrence of an item repeated within one page", async () => {
    const store = memStateStore(null);
    const { client } = scriptedClient([
      () =>
        page(
          [
            fileItem({ id: "dup-1", name: "first.pdf" }),
            fileItem({ id: "dup-1", name: "second.pdf" }),
          ],
          { deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=final" },
        ),
    ]);

    const result = await walkDelta({
      connection: { userId: "github|12345", provider: "onedrive" },
      client,
      store,
      profiles: [profile],
      initialUrl: INITIAL_URL,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ kind: "file", itemId: "dup-1", name: "second.pdf" });
  });
});

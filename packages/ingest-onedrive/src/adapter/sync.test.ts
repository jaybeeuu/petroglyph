import { describe, expect, it, vi } from "vitest";
import type { CloudEvent, EventLogWriter } from "@petroglyph/events";
import type { StagedObjectStore, StagedObjectStorePutResult } from "@petroglyph/staging-contracts";
import type { DeltaCursor, DeltaCursorStore } from "../delta/delta-cursor-store.js";
import type { GraphClient } from "../tokens/graph-client.js";
import { runDeltaSync, type DeltaContinuation } from "./sync.js";

const INITIAL_URL = "https://graph.microsoft.com/v1.0/me/drive/root/delta?$select=id,name";
const DELTA_LINK = "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=done";

const pdfBytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n%%EOF");
const nonPdfBytes = new TextEncoder().encode("this is not a pdf");

const profile = { profileId: "p1", rootPath: "notes" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scriptedClient(items: unknown[]): {
  client: GraphClient;
  paths: string[];
} {
  const paths: string[] = [];
  const client: GraphClient = {
    request(path) {
      paths.push(path);
      if (path.startsWith("/me/drive/items/")) {
        const itemId = path.split("/").at(-2);
        return Promise.resolve(
          new Response(itemId === "item-4" ? nonPdfBytes : pdfBytes, { status: 200 }),
        );
      }
      if (path.startsWith(INITIAL_URL)) {
        return Promise.resolve(jsonResponse({ value: items, "@odata.deltaLink": DELTA_LINK }));
      }
      return Promise.resolve(jsonResponse({ value: [] }));
    },
  };
  return { client, paths };
}

function makeHarness(deltaItems: unknown[]): {
  client: GraphClient;
  store: StagedObjectStore;
  puts: unknown[];
  eventLog: EventLogWriter;
  putIfAbsent: ReturnType<typeof vi.fn>;
  documents: CloudEvent<unknown>[];
  deltaCursor: ReturnType<typeof makeDeltaCursorStore>;
  deltaCursorStore: DeltaCursorStore;
  continuations: DeltaContinuation[];
  run(): Promise<Awaited<ReturnType<typeof runDeltaSync>>>;
} {
  const { client } = scriptedClient(deltaItems);
  const puts: unknown[] = [];
  const put = vi
    .fn<(key: string) => Promise<StagedObjectStorePutResult>>()
    .mockImplementation((key) => {
      puts.push(key);
      return Promise.resolve({ versionId: "v1" });
    });
  const store = {
    put,
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    presignGet: vi.fn().mockResolvedValue("https://presigned.example.com/url"),
  } as unknown as StagedObjectStore;

  const documents: CloudEvent<unknown>[] = [];
  const putIfAbsent = vi
    .fn<(document: CloudEvent<unknown>) => Promise<boolean>>()
    .mockImplementation((document) => {
      documents.push(document);
      return Promise.resolve(true);
    });
  const eventLog = { putIfAbsent } as unknown as EventLogWriter;

  const deltaCursor = makeDeltaCursorStore();
  const deltaCursorStore = deltaCursor as unknown as DeltaCursorStore;
  const continuations: DeltaContinuation[] = [];

  return {
    client,
    store,
    puts,
    eventLog,
    putIfAbsent,
    documents,
    deltaCursor,
    deltaCursorStore,
    continuations,
    run() {
      return runDeltaSync({
        client,
        store,
        eventLog,
        deltaCursorStore,
        connection: { userId: "u1", provider: "onedrive" },
        profiles: [profile],
        initialUrl: INITIAL_URL,
        requestContinuation: (continuation) => {
          continuations.push(continuation);
          return Promise.resolve();
        },
      });
    },
  };
}

function makeDeltaCursorStore(): {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
}
const SECOND_PAGE = "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=page-2";
/** A two-page delta chain whose first page carries one landable PDF. */
function twoPageClient(): { client: GraphClient; requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    client: {
      request(path) {
        requested.push(path);
        if (path === "/me/drive/items/item-1/content") {
          return Promise.resolve(new Response(pdfBytes, { status: 200 }));
        }
        if (path === INITIAL_URL) {
          return Promise.resolve(
            jsonResponse({
              value: [
                {
                  id: "item-1",
                  name: "a.pdf",
                  parentReference: { path: "/drive/root:/notes" },
                  file: { mimeType: "application/pdf" },
                },
              ],
              "@odata.nextLink": SECOND_PAGE,
            }),
          );
        }
        return Promise.resolve(jsonResponse({ value: [], "@odata.deltaLink": DELTA_LINK }));
      },
    },
  };
}

describe("runDeltaSync — adapter driver", () => {
  it("walks the delta and lands every change exactly once (staged → put+emit, deleted → emit)", async () => {
    const harness = makeHarness([
      {
        id: "item-1",
        name: "a.pdf",
        parentReference: { path: "/drive/root:/notes" },
        file: { mimeType: "application/pdf" },
      },
      {
        id: "item-2",
        name: "b.pdf",
        parentReference: { path: "/drive/root:/notes" },
        file: { mimeType: "application/pdf" },
      },
      {
        id: "item-3",
        name: "c.pdf",
        parentReference: { path: "/drive/root:/notes" },
        deleted: {},
      },
    ]);

    const result = await harness.run();

    expect(result).toEqual({
      outcome: "completed",
      landed: 2,
      deleted: 1,
      skipped: 0,
      pagesCompleted: 1,
      pagesRemaining: 0,
    });
    // two files landed → two staged emits; one deleted → one deleted emit
    expect(harness.documents).toHaveLength(3);
    expect(harness.puts).toEqual(["staging/v1/p1/notes/a.pdf", "staging/v1/p1/notes/b.pdf"]);
    // deterministic CE ids: redelivery of the same change dedupes at the event log
    expect(harness.documents.map((document) => document.id)).toEqual([
      "p1:item-1:file",
      "p1:item-2:file",
      "p1:item-3:deleted",
    ]);
    // delta cursor persisted under the profile that walked, after success
    expect(harness.deltaCursor.write).toHaveBeenCalled();
    const written = harness.deltaCursor.write.mock.calls[0] as
      | [string, { deltaLink: string }]
      | undefined;
    expect(written?.[0]).toBe("p1");
    expect(written?.[1]).toMatchObject({ deltaLink: DELTA_LINK });
  });

  it("resumes each profile from its own stored cursor, so two profiles never share a read position", async () => {
    const notesCursor = "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=notes";
    const otherCursor = "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=other";
    const requested: string[] = [];
    const client: GraphClient = {
      request(path) {
        requested.push(path);
        return Promise.resolve(jsonResponse({ value: [], "@odata.deltaLink": DELTA_LINK }));
      },
    };
    const storedCursors = new Map([
      ["notes-profile", notesCursor],
      ["other-profile", otherCursor],
    ]);
    const writtenCursors: [string, DeltaCursor][] = [];
    const deltaCursorStore: DeltaCursorStore = {
      read: (profileId) => {
        const deltaLink = storedCursors.get(profileId);
        return Promise.resolve(
          deltaLink === undefined ? null : { deltaLink, updatedAt: "2026-09-01T00:00:00.000Z" },
        );
      },
      write: (profileId, cursor) => {
        writtenCursors.push([profileId, cursor]);
        return Promise.resolve();
      },
      clear: () => Promise.resolve(),
    };

    await runDeltaSync({
      client,
      store: {
        put: vi.fn().mockResolvedValue({ versionId: "v1" }),
      } as unknown as StagedObjectStore,
      eventLog: { putIfAbsent: vi.fn().mockResolvedValue(true) } as unknown as EventLogWriter,
      deltaCursorStore,
      connection: { userId: "u1", provider: "onedrive" },
      profiles: [
        { profileId: "notes-profile", rootPath: "notes" },
        { profileId: "other-profile", rootPath: "other" },
      ],
      initialUrl: INITIAL_URL,
      requestContinuation: () => Promise.resolve(),
    });

    // Each walk starts where its own profile left off, not where the other did.
    expect(requested).toEqual([notesCursor, otherCursor]);
    expect(writtenCursors.map(([profileId]) => profileId)).toEqual([
      "notes-profile",
      "other-profile",
    ]);
  });

  it("gives two updates to one item distinct emission ids, so both reach the event log", async () => {
    const revisedItem = (eTag: string): unknown => ({
      id: "item-1",
      name: "a.pdf",
      eTag,
      parentReference: { path: "/drive/root:/notes" },
      file: { mimeType: "application/pdf" },
    });
    const firstLink = "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=first";
    const secondLink = "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=second";
    const pages: { [url: string]: unknown } = {
      [INITIAL_URL]: { value: [revisedItem("etag-1")], "@odata.deltaLink": firstLink },
      [firstLink]: { value: [revisedItem("etag-2")], "@odata.deltaLink": secondLink },
    };
    const client: GraphClient = {
      request(path) {
        if (path.startsWith("/me/drive/items/")) {
          return Promise.resolve(new Response(pdfBytes, { status: 200 }));
        }
        return Promise.resolve(jsonResponse(pages[path] ?? { value: [] }));
      },
    };

    let stored: { deltaLink: string; updatedAt: string } | null = null;
    const deltaCursorStore: DeltaCursorStore = {
      read: () => Promise.resolve(stored),
      write: (_profileId, state) => {
        stored = state;
        return Promise.resolve();
      },
      clear: () => {
        stored = null;
        return Promise.resolve();
      },
    };
    const store = {
      put: vi.fn().mockResolvedValue({ versionId: "v1" }),
    } as unknown as StagedObjectStore;

    // The real log dedupes source+id at write; mirror it so a colliding id
    // would silently drop the second, distinct update.
    const written: CloudEvent<unknown>[] = [];
    const seen = new Set<string>();
    const eventLog: EventLogWriter = {
      putIfAbsent(document) {
        const key = `${document.source}:${document.id}`;
        if (seen.has(key)) {
          return Promise.resolve(false);
        }
        seen.add(key);
        written.push(document);
        return Promise.resolve(true);
      },
    };

    const options = {
      client,
      store,
      eventLog,
      deltaCursorStore,
      connection: { userId: "u1", provider: "onedrive" },
      profiles: [profile],
      initialUrl: INITIAL_URL,
      requestContinuation: () => Promise.resolve(),
    };
    const firstRun = await runDeltaSync(options);
    const secondRun = await runDeltaSync(options);

    // Two delta runs over two edits of one item: each is a distinct event.
    expect(firstRun).toEqual({
      outcome: "completed",
      landed: 1,
      deleted: 0,
      skipped: 0,
      pagesCompleted: 1,
      pagesRemaining: 0,
    });
    expect(secondRun).toEqual({
      outcome: "completed",
      landed: 1,
      deleted: 0,
      skipped: 0,
      pagesCompleted: 1,
      pagesRemaining: 0,
    });
    expect(written.map((document) => document.id)).toEqual([
      "p1:item-1:file:etag-1",
      "p1:item-1:file:etag-2",
    ]);
  });

  it("falls back to the unversioned id and logs when a file change carries no eTag", async () => {
    const harness = makeHarness([
      {
        id: "item-1",
        name: "a.pdf",
        parentReference: { path: "/drive/root:/notes" },
        file: { mimeType: "application/pdf" },
      },
    ]);
    const logs: string[] = [];

    await runDeltaSync({
      client: harness.client,
      store: harness.store,
      eventLog: harness.eventLog,
      deltaCursorStore: harness.deltaCursorStore,
      connection: { userId: "u1", provider: "onedrive" },
      profiles: [profile],
      initialUrl: INITIAL_URL,
      requestContinuation: () => Promise.resolve(),
      log: (message) => logs.push(message),
    });

    expect(harness.documents.map((document) => document.id)).toEqual(["p1:item-1:file"]);
    expect(logs).toContainEqual(expect.stringContaining("no eTag"));
  });

  it("records a gate-rejected lie as skipped with no S3 put and no emit", async () => {
    const harness = makeHarness([
      {
        id: "item-4",
        name: "lie.pdf",
        parentReference: { path: "/drive/root:/notes" },
        file: { mimeType: "application/pdf" },
      },
    ]);

    const result = await harness.run();

    expect(result).toEqual({
      outcome: "completed",
      landed: 0,
      deleted: 0,
      skipped: 1,
      pagesCompleted: 1,
      pagesRemaining: 0,
    });
    expect(harness.puts).toEqual([]);
    expect(harness.documents).toEqual([]);
  });

  it("skips the walk entirely when the connection has no eligible profiles", async () => {
    const harness = makeHarness([]);

    const result = await runDeltaSync({
      client: harness.client,
      store: harness.store,
      eventLog: harness.eventLog,
      deltaCursorStore: harness.deltaCursorStore,
      connection: { userId: "u1", provider: "onedrive" },
      profiles: [],
      initialUrl: INITIAL_URL,
      requestContinuation: () => Promise.resolve(),
    });

    expect(result).toEqual({
      outcome: "completed",
      landed: 0,
      deleted: 0,
      skipped: 0,
      pagesCompleted: 0,
      pagesRemaining: 0,
    });
    expect(harness.deltaCursor.read).not.toHaveBeenCalled();
  });

  it("reports failed when the walk fails and processes nothing", async () => {
    const harness = makeHarness([]);
    harness.client.request = () => Promise.resolve(new Response(null, { status: 500 }));

    const result = await harness.run();

    expect(result).toEqual({
      outcome: "failed",
      landed: 0,
      deleted: 0,
      skipped: 0,
      pagesCompleted: 0,
      pagesRemaining: null,
    });
    expect(harness.documents).toEqual([]);
    expect(harness.puts).toEqual([]);
    expect(harness.deltaCursor.write).not.toHaveBeenCalled();
  });

  it("a duplicate emit (putIfAbsent false) is counted as skipped — never as landed or deleted", async () => {
    const harness = makeHarness([
      {
        id: "item-1",
        name: "a.pdf",
        parentReference: { path: "/drive/root:/notes" },
        file: { mimeType: "application/pdf" },
      },
      {
        id: "item-3",
        name: "c.pdf",
        parentReference: { path: "/drive/root:/notes" },
        deleted: {},
      },
    ]);
    harness.putIfAbsent.mockResolvedValue(false);

    const result = await harness.run();

    expect(result).toEqual({
      outcome: "completed",
      landed: 0,
      deleted: 0,
      skipped: 2,
      pagesCompleted: 1,
      pagesRemaining: 0,
    });
  });
  it("a walk that spends its page budget lands what it fetched, moves the cursor to the resume point and re-enqueues a continuation", async () => {
    const { client, requested } = twoPageClient();
    const deltaCursor = makeDeltaCursorStore();
    const continuations: DeltaContinuation[] = [];
    const result = await runDeltaSync({
      client,
      store: {
        put: vi.fn().mockResolvedValue({ versionId: "v1" }),
      } as unknown as StagedObjectStore,
      eventLog: {
        putIfAbsent: vi.fn().mockResolvedValue(true),
      } as unknown as EventLogWriter,
      deltaCursorStore: deltaCursor as unknown as DeltaCursorStore,
      connection: { userId: "u1", provider: "onedrive" },
      profiles: [profile],
      initialUrl: INITIAL_URL,
      pageBudget: 1,
      requestContinuation: (continuation) => {
        continuations.push(continuation);
        return Promise.resolve();
      },
    });
    // Landed the page it bought, and says plainly that pages remain: graph
    // reports no total, so the count is unknown rather than zero.
    expect(result).toEqual({
      outcome: "completed",
      landed: 1,
      deleted: 0,
      skipped: 0,
      pagesCompleted: 1,
      pagesRemaining: null,
    });
    expect(requested).not.toContain(SECOND_PAGE);
    // The cursor stands at the resume point, so the continuation continues the
    // walk instead of restarting the whole drive.
    const written = deltaCursor.write.mock.calls[0] as [string, { deltaLink: string }] | undefined;
    expect(written?.[0]).toBe("p1");
    expect(written?.[1]).toMatchObject({ deltaLink: SECOND_PAGE });
    expect(continuations).toEqual([
      {
        connection: { userId: "u1", provider: "onedrive" },
        deferred: [{ profileId: "p1", resumeLink: SECOND_PAGE }],
      },
    ]);
  });
  it("leaves the token and the continuation alone when landing fails, so the retry re-walks the same pages", async () => {
    const { client } = twoPageClient();
    const deltaCursor = makeDeltaCursorStore();
    const continuations: DeltaContinuation[] = [];
    await expect(
      runDeltaSync({
        client,
        store: {
          put: vi.fn().mockRejectedValue(new Error("s3 unavailable")),
        } as unknown as StagedObjectStore,
        eventLog: {
          putIfAbsent: vi.fn().mockResolvedValue(true),
        } as unknown as EventLogWriter,
        deltaCursorStore: deltaCursor as unknown as DeltaCursorStore,
        connection: { userId: "u1", provider: "onedrive" },
        profiles: [profile],
        initialUrl: INITIAL_URL,
        pageBudget: 1,
        requestContinuation: (continuation) => {
          continuations.push(continuation);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("s3 unavailable");
    // Advancing the token past unlanded changes would lose them for good.
    expect(deltaCursor.write).not.toHaveBeenCalled();
    expect(continuations).toEqual([]);
  });
});

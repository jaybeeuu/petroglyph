import { describe, expect, it, vi } from "vitest";
import type { ObjectStore, ObjectStorePutResult } from "@petroglyph/core";
import type { CloudEvent, EventLogWriter } from "@petroglyph/events";
import type { DeltaStateStore } from "../delta/delta-state-store.js";
import type { GraphClient } from "../tokens/graph-client.js";
import { runDeltaSync } from "./sync.js";

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
  store: ObjectStore;
  puts: unknown[];
  eventLog: EventLogWriter;
  documents: CloudEvent<unknown>[];
  deltaState: ReturnType<typeof makeDeltaState>;
  deltaStateStore: DeltaStateStore;
  run(): Promise<Awaited<ReturnType<typeof runDeltaSync>>>;
} {
  const { client } = scriptedClient(deltaItems);
  const puts: unknown[] = [];
  const put = vi.fn<(key: string) => Promise<ObjectStorePutResult>>().mockImplementation((key) => {
    puts.push(key);
    return Promise.resolve({ versionId: "v1" });
  });
  const store = {
    put,
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    presignGet: vi.fn().mockResolvedValue("https://presigned.example.com/url"),
  } as unknown as ObjectStore;

  const documents: CloudEvent<unknown>[] = [];
  const putIfAbsent = vi
    .fn<(document: CloudEvent<unknown>) => Promise<boolean>>()
    .mockImplementation((document) => {
      documents.push(document);
      return Promise.resolve(true);
    });
  const eventLog = { putIfAbsent } as unknown as EventLogWriter;

  const deltaState = makeDeltaState();
  const deltaStateStore = deltaState as unknown as DeltaStateStore;

  return {
    client,
    store,
    puts,
    eventLog,
    documents,
    deltaState,
    deltaStateStore,
    run() {
      return runDeltaSync({
        client,
        store,
        eventLog,
        deltaStateStore,
        connection: { userId: "u1", provider: "onedrive" },
        profiles: [profile],
        initialUrl: INITIAL_URL,
      });
    },
  };
}

function makeDeltaState(): {
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

describe("runDeltaSync — adapter driver", () => {
  it("walks the delta and lands every change exactly once (staged → put+emit, deleted → emit)", async () => {
    const harness = makeHarness([
      {
        id: "item-1",
        name: "a.pdf",
        changeType: "created",
        parentReference: { path: "/drive/root:/notes" },
        file: { mimeType: "application/pdf" },
      },
      {
        id: "item-2",
        name: "b.pdf",
        changeType: "updated",
        parentReference: { path: "/drive/root:/notes" },
        file: { mimeType: "application/pdf" },
      },
      {
        id: "item-3",
        name: "c.pdf",
        changeType: "deleted",
        parentReference: { path: "/drive/root:/notes" },
        deleted: {},
      },
    ]);

    const result = await harness.run();

    expect(result).toEqual({ outcome: "completed", landed: 2, deleted: 1, skipped: 0 });
    // two PDFs landed → two staged emits; one deleted → one deleted emit
    expect(harness.documents).toHaveLength(3);
    expect(harness.puts).toEqual(["staging/v1/p1/notes/a.pdf", "staging/v1/p1/notes/b.pdf"]);
    // deterministic CE ids: redelivery of the same change dedupes at the event log
    expect(harness.documents.map((document) => document.id)).toEqual([
      "p1:item-1:created",
      "p1:item-2:updated",
      "p1:item-3:deleted",
    ]);
    // delta token persisted after a successful walk
    expect(harness.deltaState.write).toHaveBeenCalled();
    const written = harness.deltaState.write.mock.calls[0] as
      | [string, string, { deltaLink: string }]
      | undefined;
    expect(written?.[0]).toBe("u1");
    expect(written?.[1]).toBe("onedrive");
    expect(written?.[2]).toMatchObject({ deltaLink: DELTA_LINK });
  });

  it("records a gate-rejected lie as skipped with no S3 put and no emit", async () => {
    const harness = makeHarness([
      {
        id: "item-4",
        name: "lie.pdf",
        changeType: "created",
        parentReference: { path: "/drive/root:/notes" },
        file: { mimeType: "application/pdf" },
      },
    ]);

    const result = await harness.run();

    expect(result).toEqual({ outcome: "completed", landed: 0, deleted: 0, skipped: 1 });
    expect(harness.puts).toEqual([]);
    expect(harness.documents).toEqual([]);
  });

  it("skips the walk entirely when the connection has no eligible profiles", async () => {
    const harness = makeHarness([]);

    const result = await runDeltaSync({
      client: harness.client,
      store: harness.store,
      eventLog: harness.eventLog,
      deltaStateStore: harness.deltaStateStore,
      connection: { userId: "u1", provider: "onedrive" },
      profiles: [],
      initialUrl: INITIAL_URL,
    });

    expect(result).toEqual({ outcome: "completed", landed: 0, deleted: 0, skipped: 0 });
    expect(harness.deltaState.read).not.toHaveBeenCalled();
  });

  it("reports failed when the walk fails and processes nothing", async () => {
    const harness = makeHarness([]);
    harness.client.request = () => Promise.resolve(new Response(null, { status: 500 }));

    const result = await harness.run();

    expect(result).toEqual({ outcome: "failed", landed: 0, deleted: 0, skipped: 0 });
    expect(harness.documents).toEqual([]);
    expect(harness.puts).toEqual([]);
    expect(harness.deltaState.write).not.toHaveBeenCalled();
  });
});

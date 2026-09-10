import { describe, expect, it, vi } from "vitest";
import { processChange, type ProcessChangeDeps } from "./process-change.js";
import type { GraphClient } from "../tokens/graph-client.js";
import type { ObjectStore } from "@petroglyph/core";
import type { FileChangeEvent } from "../delta/delta-walk.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj");
const HTML_BYTES = new TextEncoder().encode("<!DOCTYPE html><html><body>fake</body></html>");

const created: FileChangeEvent = {
  profileId: "p1",
  changeType: "created",
  itemId: "item-1",
  name: "a.pdf",
  relativePath: "notes",
  mimeType: "application/pdf",
  isFolder: false,
};

const updated: FileChangeEvent = { ...created, changeType: "updated" };

const deletedChange: FileChangeEvent = {
  profileId: "p1",
  changeType: "deleted",
  itemId: "item-1",
  name: "a.pdf",
  relativePath: "notes",
  isFolder: false,
};

const folderDeleted: FileChangeEvent = {
  ...deletedChange,
  itemId: "folder-1",
  name: "sub",
  relativePath: "notes/sub",
  isFolder: true,
};

function bytesResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, { status });
}

interface Harness {
  graph: GraphClient;
  request: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  putIfAbsent: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  run: (change: FileChangeEvent, emissionId?: string) => Promise<string>;
}

function makeHarness(
  scriptedGraph: (path: string) => Response = () => bytesResponse(PDF_BYTES),
): Harness {
  const request = vi.fn<(path: string) => Promise<Response>>();
  request.mockImplementation((path: string) => Promise.resolve(scriptedGraph(path)));
  const graph: GraphClient = { request };
  const put = vi.fn().mockResolvedValue({});
  const store = { put } as unknown as ObjectStore;
  const putIfAbsent = vi.fn<(document: unknown) => Promise<boolean>>().mockResolvedValue(true);
  const eventLog = { putIfAbsent };
  const log = vi.fn<(message: string) => void>();
  const deps: ProcessChangeDeps = {
    graph,
    store,
    eventLog,
    log,
    emissionId: "emission-default",
  };
  return {
    graph,
    request,
    put,
    putIfAbsent,
    log,
    run: (change, emissionId) =>
      processChange(change, { ...deps, emissionId: emissionId ?? "emission-default" }),
  };
}

describe("processChange", () => {
  it("fetches /content, lands the bytes with the detected content type, then emits FileStagedEvent", async () => {
    const { request, put, putIfAbsent, run } = makeHarness();

    const outcome = await run(created);

    expect(outcome).toBe("landed");
    const contentPath = request.mock.calls[0]?.[0] as string;
    expect(contentPath).toBe("/me/drive/items/item-1/content");

    const putCall = put.mock.calls[0] as [string, Uint8Array, { contentType: string }];
    expect(putCall[0]).toBe("staging/v1/p1/notes/a.pdf");
    expect(putCall[1]).toEqual(PDF_BYTES);
    expect(putCall[2]).toEqual({ contentType: "application/pdf" });

    expect(putIfAbsent).toHaveBeenCalledTimes(1);
    const document = putIfAbsent.mock.calls[0]?.[0] as {
      id: string;
      type: string;
      source: string;
      data: { [key: string]: unknown };
    };
    expect(document.type).toBe("petroglyph.file.staged");
    expect(document.id).toBe("emission-default");
    expect(document.source).toBe("onedrive://profiles/p1");
    expect(document.data).toMatchObject({
      profileId: "p1",
      source: "onedrive",
      changeType: "created",
      itemId: "item-1",
      name: "a.pdf",
      relativePath: "notes",
      s3Key: "staging/v1/p1/notes/a.pdf",
      mimeType: "application/pdf",
    });
  });

  it("pre-filter: claim and extension both non-pdf -> no download, no land, no event", async () => {
    const harness = makeHarness();
    const nonPdf: FileChangeEvent = {
      ...created,
      name: "notes.txt",
      mimeType: "text/plain",
    };

    const outcome = await harness.run(nonPdf);

    expect(outcome).toBe("skipped");
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.put).not.toHaveBeenCalled();
    expect(harness.putIfAbsent).not.toHaveBeenCalled();
  });

  it("gate+land: mimeType in the event equals the detected type, never the vendor claim", async () => {
    const claimLied: FileChangeEvent = {
      ...created,
      mimeType: "application/octet-stream", // vendor claims otherwise; bytes decide
    };
    const { putIfAbsent, run } = makeHarness();

    await run(claimLied);

    const document = putIfAbsent.mock.calls[0]?.[0] as {
      data: { mimeType: string; s3Key: string };
    };
    expect(document.data.mimeType).toBe("application/pdf");
    expect(document.data.s3Key).toBe("staging/v1/p1/notes/a.pdf");
  });

  it("updated changes land with changeType updated", async () => {
    const { putIfAbsent, run } = makeHarness();
    await run(updated);

    const document = putIfAbsent.mock.calls[0]?.[0] as { data: { changeType: string } };
    expect(document.data.changeType).toBe("updated");
  });

  it("lie telemetry: claim pdf but bytes are not a PDF -> no put, no event, triple logged", async () => {
    const harness = makeHarness(() => bytesResponse(HTML_BYTES));

    const outcome = await harness.run(created);

    expect(outcome).toBe("gate-rejected");
    expect(harness.put).not.toHaveBeenCalled();
    expect(harness.putIfAbsent).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledTimes(1);
    const triple = harness.log.mock.calls[0]?.[0] as string;
    expect(triple).toContain("application/pdf"); // claim
    expect(triple).toContain("a.pdf"); // extension
    expect(triple).toContain("null"); // detected
  });

  it("deleted: emits FileDeletedEvent with the derived s3Key and never deletes the object", async () => {
    const { put, putIfAbsent, run } = makeHarness();

    const outcome = await run(deletedChange);

    expect(outcome).toBe("deleted");
    expect(put).not.toHaveBeenCalled();
    const document = putIfAbsent.mock.calls[0]?.[0] as {
      type: string;
      data: { changeType: string; s3Key: string | null };
    };
    expect(document.type).toBe("petroglyph.file.deleted");
    expect(document.data).toMatchObject({
      changeType: "deleted",
      itemId: "item-1",
      relativePath: "notes",
      s3Key: "staging/v1/p1/notes/a.pdf",
    });
  });

  it("folder deletes emit s3Key null (path-level delete) and still never delete objects", async () => {
    const { put, putIfAbsent, run } = makeHarness();

    await run(folderDeleted);

    expect(put).not.toHaveBeenCalled();
    const document = putIfAbsent.mock.calls[0]?.[0] as { data: { s3Key: string | null } };
    expect(document.data.s3Key).toBeNull();
  });

  it("fetch 404: no land, no event, logged (the next walk re-evaluates)", async () => {
    const harness = makeHarness(() => bytesResponse(new Uint8Array(0), 404));

    const outcome = await harness.run(created);

    expect(outcome).toBe("fetch-404");
    expect(harness.put).not.toHaveBeenCalled();
    expect(harness.putIfAbsent).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledTimes(1);
  });

  it("fetch 5xx surfaces as a failure: no partial event, caller retries the job", async () => {
    const harness = makeHarness(() => bytesResponse(new Uint8Array(0), 503));

    await expect(harness.run(created)).rejects.toThrow();
    expect(harness.put).not.toHaveBeenCalled();
    expect(harness.putIfAbsent).not.toHaveBeenCalled();
  });

  it("emit failure leaves the object in place and surfaces the failure (no event, determinism preserved)", async () => {
    const harness = makeHarness();
    harness.putIfAbsent.mockRejectedValue(new Error("event-log write failed"));

    await expect(harness.run(created)).rejects.toThrow();
    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(harness.putIfAbsent).toHaveBeenCalledTimes(1);
  });

  it("idempotency by construction: the same change re-derives the same key", async () => {
    const { put, run } = makeHarness();

    await run(created);
    await run(created);

    const calls = put.mock.calls as [string, Uint8Array, { contentType: string }][];
    expect(calls.map((call) => call[0])).toEqual([
      "staging/v1/p1/notes/a.pdf",
      "staging/v1/p1/notes/a.pdf",
    ]);
  });

  it("redelivery of the same job reuses the emission id — the log dedupes source+id at write (row 7)", async () => {
    const { run, putIfAbsent } = makeHarness();

    await run(created, "emission-1");
    await run(created, "emission-1");

    const ids = putIfAbsent.mock.calls.map((call) => (call[0] as { id: string }).id);
    expect(ids).toEqual(["emission-1", "emission-1"]);
    expect(putIfAbsent.mock.calls.length).toBe(2);
  });
});

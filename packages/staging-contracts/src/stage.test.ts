import { describe, expect, it, vi } from "vitest";
import { stage } from "./stage.js";
import type { ObjectStore } from "@petroglyph/core";

describe("stage", () => {
  it("derives the key once and puts exactly once with the derived key and content type", async () => {
    const put = vi.fn().mockResolvedValue({ versionId: "v-9" });
    const store = { put } as unknown as ObjectStore;

    const result = await stage(store, {
      profileId: "p1",
      relativePath: "a/b",
      name: "note.pdf",
      body: new TextEncoder().encode("%PDF-1.7"),
      contentType: "application/pdf",
    });

    expect(result).toEqual({
      s3Key: "staging/v1/p1/a/b/note.pdf",
      versionId: "v-9",
    });
    expect(put).toHaveBeenCalledTimes(1);
    const call = put.mock.calls[0] as [string, Uint8Array, { contentType: string }];
    expect(call[0]).toBe("staging/v1/p1/a/b/note.pdf");
    expect(call[2]).toEqual({ contentType: "application/pdf" });
  });

  it("reports no version id when the store returns none", async () => {
    const put = vi.fn().mockResolvedValue({});
    const store = { put } as unknown as ObjectStore;

    const result = await stage(store, {
      profileId: "p1",
      relativePath: "a/b",
      name: "note.pdf",
      body: new TextEncoder().encode("%PDF-1.7"),
      contentType: "application/pdf",
    });

    expect(result).toEqual({ s3Key: "staging/v1/p1/a/b/note.pdf" });
  });

  it("is idempotent by construction — same input derives the same key", async () => {
    const put = vi.fn().mockResolvedValue({});
    const store = { put } as unknown as ObjectStore;

    await stage(store, {
      profileId: "p1",
      relativePath: "a/b",
      name: "note.pdf",
      body: new TextEncoder().encode("%PDF-1.7"),
      contentType: "application/pdf",
    });
    await stage(store, {
      profileId: "p1",
      relativePath: "a/b",
      name: "note.pdf",
      body: new TextEncoder().encode("%PDF-1.7"),
      contentType: "application/pdf",
    });

    const calls = put.mock.calls as [string, Uint8Array, { contentType: string }][];
    expect(calls.map((call) => call[0])).toEqual([
      "staging/v1/p1/a/b/note.pdf",
      "staging/v1/p1/a/b/note.pdf",
    ]);
  });
});

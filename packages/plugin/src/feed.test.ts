import { describe, expect, it } from "vitest";
import { parseFilesFeed, resolveVaultRoot, vaultPathsFor } from "./feed.js";

function createFeedEntry(overrides: { [key: string]: unknown } = {}): {
  [key: string]: unknown;
} {
  return {
    itemId: "item-1",
    name: "note.pdf",
    relativePath: "notes",
    mimeType: "application/pdf",
    s3PresignedUrl: "https://s3.example.com/note.pdf",
    createdAt: "2026-04-11T10:00:00Z",
    ...overrides,
  };
}

describe("parseFilesFeed", () => {
  it("returns the files and cursor from a valid feed payload", () => {
    const feed = parseFilesFeed({
      files: [
        createFeedEntry({ itemId: "item-1", name: "a.pdf" }),
        createFeedEntry({ itemId: "item-2", name: "b.pdf" }),
      ],
      nextToken: "cursor-2",
    });

    expect(feed?.files.map((file) => file.itemId)).toEqual(["item-1", "item-2"]);
    expect(feed?.nextToken).toBe("cursor-2");
  });

  it("accepts an exhausted feed", () => {
    const feed = parseFilesFeed({ files: [], nextToken: null });

    expect(feed).toEqual({ files: [], nextToken: null });
  });

  it("rejects an entry without a presigned URL", () => {
    const { s3PresignedUrl: _ignored, ...withoutUrl } = createFeedEntry();

    expect(parseFilesFeed({ files: [withoutUrl], nextToken: null })).toBeNull();
  });

  it("rejects a non-string cursor", () => {
    expect(parseFilesFeed({ files: [], nextToken: 2 })).toBeNull();
  });

  it("rejects a payload that is not a feed", () => {
    expect(parseFilesFeed(null)).toBeNull();
  });
});

describe("vaultPathsFor", () => {
  it("nests the file under its relative path", () => {
    const result = vaultPathsFor(
      "handwritten",
      parseFilesFeedOrThrow({ relativePath: "notes/2026" }),
    );

    expect(result).toEqual({
      ok: true,
      paths: { pdf: "handwritten/notes/2026/note.pdf", markdown: "handwritten/notes/2026/note.md" },
    });
  });

  it("places a file with no relative path directly under the root", () => {
    const result = vaultPathsFor("handwritten", parseFilesFeedOrThrow({ relativePath: "" }));

    expect(result).toEqual({
      ok: true,
      paths: { pdf: "handwritten/note.pdf", markdown: "handwritten/note.md" },
    });
  });

  it("strips leading and trailing slashes from the relative path", () => {
    const result = vaultPathsFor("handwritten", parseFilesFeedOrThrow({ relativePath: "/notes/" }));

    expect(result).toEqual({
      ok: true,
      paths: { pdf: "handwritten/notes/note.pdf", markdown: "handwritten/notes/note.md" },
    });
  });

  it("treats a backslash as a separator", () => {
    const result = vaultPathsFor(
      "handwritten",
      parseFilesFeedOrThrow({ relativePath: "notes\\2026" }),
    );

    expect(result).toEqual({
      ok: true,
      paths: { pdf: "handwritten/notes/2026/note.pdf", markdown: "handwritten/notes/2026/note.md" },
    });
  });

  it("keeps the original extension in the companion note path", () => {
    const result = vaultPathsFor("handwritten", parseFilesFeedOrThrow({ name: "Note.PDF" }));

    expect(result).toEqual({
      ok: true,
      paths: { pdf: "handwritten/notes/Note.PDF", markdown: "handwritten/notes/Note.md" },
    });
  });

  it("rejects a relative path that climbs out of the vault", () => {
    expect(vaultPathsFor("handwritten", parseFilesFeedOrThrow({ relativePath: "../.." }))).toEqual({
      ok: false,
    });
  });

  it("rejects a relative path that only escapes after a nested climb", () => {
    expect(
      vaultPathsFor("handwritten", parseFilesFeedOrThrow({ relativePath: "notes/../.." })),
    ).toEqual({ ok: false });
  });

  it("rejects a relative path that climbs through backslashes", () => {
    expect(
      vaultPathsFor("handwritten", parseFilesFeedOrThrow({ relativePath: "..\\..\\etc" })),
    ).toEqual({ ok: false });
  });

  it("rejects a relative path that climbs through mixed separators", () => {
    expect(
      vaultPathsFor("handwritten", parseFilesFeedOrThrow({ relativePath: "notes\\../../etc" })),
    ).toEqual({ ok: false });
  });

  it("rejects a file name that carries a climb", () => {
    expect(vaultPathsFor("handwritten", parseFilesFeedOrThrow({ name: "../../x.pdf" }))).toEqual({
      ok: false,
    });
  });
});

describe("resolveVaultRoot", () => {
  it("keeps a destination that is already canonical", () => {
    expect(resolveVaultRoot("twiy-proof")).toEqual({ ok: true, root: "twiy-proof" });
  });

  it("strips leading, trailing and repeated slashes", () => {
    expect(resolveVaultRoot("//twiy-proof//proofs/")).toEqual({
      ok: true,
      root: "twiy-proof/proofs",
    });
  });

  it("falls back to the default root when the destination is empty", () => {
    expect(resolveVaultRoot("")).toEqual({ ok: true, root: "handwritten" });
  });

  it("treats a whitespace-only destination as empty", () => {
    expect(resolveVaultRoot("   ")).toEqual({ ok: true, root: "handwritten" });
  });

  it("falls back to the default root when the destination is missing", () => {
    expect(resolveVaultRoot(undefined)).toEqual({ ok: true, root: "handwritten" });
  });

  it("treats a backslash as a separator", () => {
    expect(resolveVaultRoot("twiy-proof\\proofs")).toEqual({ ok: true, root: "twiy-proof/proofs" });
  });

  it("normalises a leading slash into a vault-relative folder", () => {
    expect(resolveVaultRoot("/etc/x")).toEqual({ ok: true, root: "etc/x" });
  });

  it("rejects a destination that escapes the vault", () => {
    expect(resolveVaultRoot("../outside")).toEqual({ ok: false });
  });

  it("rejects a destination that only escapes after a nested climb", () => {
    expect(resolveVaultRoot("notes/../../outside")).toEqual({ ok: false });
  });

  it("rejects a destination that climbs through backslashes", () => {
    expect(resolveVaultRoot("..\\x")).toEqual({ ok: false });
  });

  it("rejects a destination that is only a backslash climb", () => {
    expect(resolveVaultRoot("..\\..")).toEqual({ ok: false });
  });

  it("rejects a destination that climbs through a nested backslash climb", () => {
    expect(resolveVaultRoot("a\\..\\..\\b")).toEqual({ ok: false });
  });

  it("rejects a destination that climbs through mixed separators", () => {
    expect(resolveVaultRoot("../..\\x")).toEqual({ ok: false });
  });
});

function parseFilesFeedOrThrow(overrides: {
  [key: string]: unknown;
}): NonNullable<ReturnType<typeof parseFilesFeed>>["files"][number] {
  const feed = parseFilesFeed({ files: [createFeedEntry(overrides)], nextToken: null });
  if (feed === null || feed.files[0] === undefined) {
    throw new Error("Expected the feed payload to parse.");
  }
  return feed.files[0];
}

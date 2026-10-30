import { describe, expect, it } from "vitest";
import { parseFilesFeed, vaultPathsFor } from "./feed.js";

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
    const paths = vaultPathsFor(
      "handwritten",
      parseFilesFeedOrThrow({ relativePath: "notes/2026" }),
    );

    expect(paths.pdf).toBe("handwritten/notes/2026/note.pdf");
    expect(paths.markdown).toBe("handwritten/notes/2026/note.md");
  });

  it("places a file with no relative path directly under the root", () => {
    const paths = vaultPathsFor("handwritten", parseFilesFeedOrThrow({ relativePath: "" }));

    expect(paths.pdf).toBe("handwritten/note.pdf");
    expect(paths.markdown).toBe("handwritten/note.md");
  });

  it("strips leading and trailing slashes from the relative path", () => {
    const paths = vaultPathsFor("handwritten", parseFilesFeedOrThrow({ relativePath: "/notes/" }));

    expect(paths.pdf).toBe("handwritten/notes/note.pdf");
  });

  it("keeps the original extension in the companion note path", () => {
    const paths = vaultPathsFor("handwritten", parseFilesFeedOrThrow({ name: "Note.PDF" }));

    expect(paths.markdown).toBe("handwritten/notes/Note.md");
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

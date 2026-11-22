import { describe, expect, it } from "vitest";
import { deriveStagingKey, deriveStagingPrefix } from "./keys.js";

describe("deriveStagingPrefix", () => {
  it("derives staging/v1/<profileId>/ as the profile's own subtree", () => {
    expect(deriveStagingPrefix({ profileId: "p1" })).toBe("staging/v1/p1/");
  });

  it("ends at a segment boundary, so one profile's prefix never matches another's keys", () => {
    const prefix = deriveStagingPrefix({ profileId: "p1" });
    const otherKey = deriveStagingKey({ profileId: "p10", relativePath: "a", name: "note.pdf" });
    expect(otherKey.startsWith(prefix)).toBe(false);
  });

  it("rejects an unsafe profileId", () => {
    expect(() => deriveStagingPrefix({ profileId: "" })).toThrow();
    expect(() => deriveStagingPrefix({ profileId: "../p1" })).toThrow();
  });
});

describe("deriveStagingKey", () => {
  it("derives staging/v1/<profileId>/<relativePath>/<name> with the layout version in the key", () => {
    expect(deriveStagingKey({ profileId: "p1", relativePath: "a/b", name: "note.pdf" })).toBe(
      "staging/v1/p1/a/b/note.pdf",
    );
  });

  it("keeps the name verbatim — no extension surgery", () => {
    expect(deriveStagingKey({ profileId: "p1", relativePath: "a", name: "note.PDF" })).toBe(
      "staging/v1/p1/a/note.PDF",
    );
    expect(deriveStagingKey({ profileId: "p1", relativePath: "a", name: "notes" })).toBe(
      "staging/v1/p1/a/notes",
    );
  });

  it("rejects traversal segments", () => {
    expect(() =>
      deriveStagingKey({ profileId: "p1", relativePath: "../secret", name: "note.pdf" }),
    ).toThrow();
    expect(() =>
      deriveStagingKey({ profileId: "p1", relativePath: "a/../b", name: "note.pdf" }),
    ).toThrow();
    expect(() => deriveStagingKey({ profileId: "p1", relativePath: "a", name: ".." })).toThrow();
  });

  it("rejects leading slashes", () => {
    expect(() =>
      deriveStagingKey({ profileId: "p1", relativePath: "/a/b", name: "note.pdf" }),
    ).toThrow();
  });

  it("rejects empty segments", () => {
    expect(() =>
      deriveStagingKey({ profileId: "p1", relativePath: "a//b", name: "note.pdf" }),
    ).toThrow();
    expect(() =>
      deriveStagingKey({ profileId: "p1", relativePath: "", name: "note.pdf" }),
    ).toThrow();
    expect(() =>
      deriveStagingKey({ profileId: "", relativePath: "a", name: "note.pdf" }),
    ).toThrow();
  });

  it("keeps the layout version constant in the key for evolution checks", () => {
    expect(deriveStagingKey({ profileId: "p1", relativePath: "a", name: "note.pdf" })).toContain(
      "/v1/",
    );
  });
});

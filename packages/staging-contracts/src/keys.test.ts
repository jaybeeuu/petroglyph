import { describe, expect, it } from "vitest";
import { deriveStagingKey, stagingPrefix } from "./keys.js";

describe("stagingPrefix", () => {
  it("is the one place the staging layout is spelled, versioned in the key", () => {
    expect(stagingPrefix({ profileId: "p1" })).toBe("staging/v1/p1");
  });

  it("rejects a profile id that could escape the prefix", () => {
    expect(() => stagingPrefix({ profileId: "../other" })).toThrow();
    expect(() => stagingPrefix({ profileId: "" })).toThrow();
  });
});

describe("deriveStagingKey", () => {
  it("builds the key under the prefix function, never alongside it", () => {
    expect(deriveStagingKey({ profileId: "p1", relativePath: "a/b", name: "note.pdf" })).toBe(
      `${stagingPrefix({ profileId: "p1" })}/a/b/note.pdf`,
    );
  });

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

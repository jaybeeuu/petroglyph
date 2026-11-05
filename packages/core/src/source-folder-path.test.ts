import { describe, expect, it } from "vitest";
import { normalizeSourceFolderPath } from "./source-folder-path.js";

describe("normalizeSourceFolderPath", () => {
  it("strips a leading slash so a stored path matches delta relative paths", () => {
    expect(normalizeSourceFolderPath("/onyx/NoteAir5C/Notebooks")).toBe("onyx/NoteAir5C/Notebooks");
  });

  it("strips a trailing slash", () => {
    expect(normalizeSourceFolderPath("onyx/NoteAir5C/Notebooks/")).toBe("onyx/NoteAir5C/Notebooks");
  });

  it("collapses repeated slashes", () => {
    expect(normalizeSourceFolderPath("//onyx//NoteAir5C///Notebooks")).toBe(
      "onyx/NoteAir5C/Notebooks",
    );
  });

  it("keeps the whole drive as '/'", () => {
    expect(normalizeSourceFolderPath("/")).toBe("/");
  });

  it("leaves an already normalized path unchanged", () => {
    expect(normalizeSourceFolderPath("onyx/NoteAir5C/Notebooks")).toBe("onyx/NoteAir5C/Notebooks");
  });
});

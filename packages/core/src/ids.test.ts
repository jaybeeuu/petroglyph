import { describe, expect, it } from "vitest";
import {
  asApplicationUserId,
  asNoteId,
  asProviderConnectionId,
  asProviderId,
  asVersionId,
  isApplicationUserId,
  isNoteId,
  isProviderConnectionId,
  isProviderId,
  isVersionId,
} from "./ids.js";

describe("brand-cast helpers", () => {
  it("asNoteId returns the input string as NoteId", () => {
    expect(asNoteId("note-1")).toBe("note-1");
  });

  it("asVersionId returns the input string as VersionId", () => {
    expect(asVersionId("v-1")).toBe("v-1");
  });

  it("asProviderId returns the input string as ProviderId", () => {
    expect(asProviderId("github")).toBe("github");
  });

  it("asProviderConnectionId returns the input string as ProviderConnectionId", () => {
    expect(asProviderConnectionId("conn-1")).toBe("conn-1");
  });

  it("asApplicationUserId returns the input string as ApplicationUserId", () => {
    expect(asApplicationUserId("user-1")).toBe("user-1");
  });
});

describe("type guards", () => {
  it("isNoteId returns true for a string", () => {
    expect(isNoteId("note-1")).toBe(true);
  });

  it("isNoteId returns false for a non-string", () => {
    expect(isNoteId(42)).toBe(false);
    expect(isNoteId(null)).toBe(false);
    expect(isNoteId({})).toBe(false);
  });

  it("isVersionId returns true for a string", () => {
    expect(isVersionId("v-1")).toBe(true);
  });

  it("isVersionId returns false for a non-string", () => {
    expect(isVersionId(42)).toBe(false);
  });

  it("isProviderId returns true for a string", () => {
    expect(isProviderId("github")).toBe(true);
  });

  it("isProviderId returns false for a non-string", () => {
    expect(isProviderId(false)).toBe(false);
  });

  it("isProviderConnectionId returns true for a string", () => {
    expect(isProviderConnectionId("conn-1")).toBe(true);
  });

  it("isProviderConnectionId returns false for a non-string", () => {
    expect(isProviderConnectionId(undefined)).toBe(false);
  });

  it("isApplicationUserId returns true for a string", () => {
    expect(isApplicationUserId("user-1")).toBe(true);
  });

  it("isApplicationUserId returns false for a non-string", () => {
    expect(isApplicationUserId([])).toBe(false);
  });
});

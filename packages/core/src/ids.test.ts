import { describe, expect, it } from "vitest";
import {
  asApplicationUserId,
  asAuthIdentityId,
  asNoteId,
  asProviderConnectionId,
  asProviderId,
  asVersionId,
  isApplicationUserId,
  isAuthIdentityId,
  isNoteId,
  isProviderConnectionId,
  isProviderId,
  isVersionId,
} from "./ids.js";

describe("brand-cast helpers", () => {
  it.each([
    { helperName: "asNoteId", fn: asNoteId, input: "note-1" },
    { helperName: "asVersionId", fn: asVersionId, input: "v-1" },
    { helperName: "asProviderId", fn: asProviderId, input: "github" },
    { helperName: "asProviderConnectionId", fn: asProviderConnectionId, input: "conn-1" },
    { helperName: "asApplicationUserId", fn: asApplicationUserId, input: "user-1" },
    { helperName: "asAuthIdentityId", fn: asAuthIdentityId, input: "identity-1" },
  ])("$helperName returns the input string as-is", ({ fn, input }) => {
    expect(fn(input)).toBe(input);
  });
});

describe("type guards", () => {
  it.each([
    { guardName: "isNoteId", fn: isNoteId },
    { guardName: "isVersionId", fn: isVersionId },
    { guardName: "isProviderId", fn: isProviderId },
    { guardName: "isProviderConnectionId", fn: isProviderConnectionId },
    { guardName: "isApplicationUserId", fn: isApplicationUserId },
    { guardName: "isAuthIdentityId", fn: isAuthIdentityId },
  ])("$guardName returns true for a string", ({ fn }) => {
    expect(fn("test-value")).toBe(true);
  });

  it.each([
    { guardName: "isNoteId", fn: isNoteId },
    { guardName: "isVersionId", fn: isVersionId },
    { guardName: "isProviderId", fn: isProviderId },
    { guardName: "isProviderConnectionId", fn: isProviderConnectionId },
    { guardName: "isApplicationUserId", fn: isApplicationUserId },
    { guardName: "isAuthIdentityId", fn: isAuthIdentityId },
  ])("$guardName returns false for non-string values", ({ fn }) => {
    expect(fn(42)).toBe(false);
    expect(fn(null)).toBe(false);
    expect(fn({})).toBe(false);
    expect(fn(undefined)).toBe(false);
  });
});

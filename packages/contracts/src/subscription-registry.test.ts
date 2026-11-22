import { describe, expect, it } from "vitest";
// Imported through the package entry point: the subscribe action, the renewer
// and the webhook lookup all receive the schema from `@petroglyph/contracts`,
// so an export that stops at this module is an export they cannot use.
import { subscriptionRegistryItemSchema } from "./index.js";

/**
 * A registry row is untrusted storage content, so the cases are built as plain
 * records: a broken row is a real shape a reader must reject, not a value the
 * compiler already refused.
 */
function createRegistryItem(overrides: { [key: string]: unknown } = {}): {
  [key: string]: unknown;
} {
  return {
    profileId: "profile-7",
    provider: "onedrive",
    root: "/Documents/writing",
    folderItemId: "01ABCDEF0123456789",
    subscriptionId: "subscription-1",
    deltaLink: "https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=opaque",
    // A literal a reader recognises as a fixture: `clientStateSecret` is a real
    // credential in production, so a randomly shaped value here reads as a leak.
    clientStateSecret: "test-client-state-secret",
    expiry: 1767225600,
    subscriptionState: "active",
    ...overrides,
  };
}

describe("subscriptionRegistryItemSchema", () => {
  it("reads an active row whole, so the renewer and the webhook see every field", () => {
    const row = createRegistryItem();

    expect(subscriptionRegistryItemSchema.parse(row)).toStrictEqual({
      profileId: "profile-7",
      provider: "onedrive",
      root: "/Documents/writing",
      folderItemId: "01ABCDEF0123456789",
      subscriptionId: "subscription-1",
      deltaLink: "https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=opaque",
      clientStateSecret: "test-client-state-secret",
      expiry: 1767225600,
      subscriptionState: "active",
    });
  });

  it("accepts a pending row that names no subscription yet", () => {
    const row = createRegistryItem({
      subscriptionState: "pending",
      subscriptionId: undefined,
      deltaLink: undefined,
      clientStateSecret: undefined,
      expiry: undefined,
    });

    const parsed = subscriptionRegistryItemSchema.parse(row);

    expect(parsed.subscriptionState).toBe("pending");
    expect(parsed.subscriptionId).toBeUndefined();
  });

  it("rejects an active row that names no expiry, so a renewal cannot read a row with no window", () => {
    const row = createRegistryItem({ expiry: undefined });

    expect(subscriptionRegistryItemSchema.safeParse(row).success).toBe(false);
  });

  it("rejects an active row whose expiry is a timestamp string rather than the epoch seconds the index sorts", () => {
    const row = createRegistryItem({ expiry: "2026-01-01T00:00:00.000Z" });

    expect(subscriptionRegistryItemSchema.safeParse(row).success).toBe(false);
  });

  it("rejects a row that names no profile, so a lookup cannot answer with an unkeyed row", () => {
    const row = createRegistryItem({ profileId: undefined });

    expect(subscriptionRegistryItemSchema.safeParse(row).success).toBe(false);
  });

  it("rejects a stored stale state, which the walk derives and never writes", () => {
    const row = createRegistryItem({ subscriptionState: "stale" });

    expect(subscriptionRegistryItemSchema.safeParse(row).success).toBe(false);
  });
});

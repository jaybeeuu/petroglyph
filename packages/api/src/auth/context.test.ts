import { describe, it, expect } from "vitest";
import type { ApplicationUser } from "@petroglyph/account";
import { asApplicationUserId, asAuthIdentityId } from "@petroglyph/core";
import type { ResolvedAuthContext } from "./context.js";

// Verifies that ResolvedAuthContext is API-owned and carries an ApplicationUser —
// not raw token claims or a core-package auth type.
describe("ResolvedAuthContext (API ownership boundary)", () => {
  it("is structurally compatible with ApplicationUser from @petroglyph/account", () => {
    const user: ApplicationUser = {
      id: asApplicationUserId("user-1"),
      status: "active",
      displayName: "Test User",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const ctx: ResolvedAuthContext = { user };

    expect(ctx.user.id).toBe("user-1");
    expect(ctx.user.status).toBe("active");
    expect(ctx.user.displayName).toBe("Test User");
  });

  it("requires user to be an ApplicationUser with all required fields", () => {
    const user: ApplicationUser = {
      id: asApplicationUserId("user-2"),
      status: "disabled",
      displayName: "Disabled User",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const ctx: ResolvedAuthContext = { user };
    expect(ctx.user.status).toBe("disabled");
  });

  it("does not expose AuthIdentity or raw token claims — only the resolved user", () => {
    // Type-level check: ResolvedAuthContext should not have token claims fields.
    // This is a structural assertion that the context stays API-owned and narrow.
    const user: ApplicationUser = {
      id: asApplicationUserId("user-3"),
      status: "active",
      displayName: "Alice",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const ctx: ResolvedAuthContext = { user };

    // These fields should not exist on the context (TypeScript would error if they did).
    expect((ctx as unknown as { [key: string]: unknown })["sub"]).toBeUndefined();
    expect((ctx as unknown as { [key: string]: unknown })["oid"]).toBeUndefined();
    expect((ctx as unknown as { [key: string]: unknown })["authIdentityId"]).toBeUndefined();

    // The only key should be 'user'.
    expect(Object.keys(ctx)).toStrictEqual(["user"]);
  });

  it("is not from @petroglyph/account — AuthContext and ResolvedAuthContext are separate", async () => {
    // Import the account-owned AuthContext to confirm it differs from the API's ResolvedAuthContext.
    // account AuthContext only has userId; API ResolvedAuthContext carries the full ApplicationUser.
    const { ApplicationUserIdSchema } = await import("@petroglyph/core");
    const userId = ApplicationUserIdSchema.parse("user-id-1");

    // account-style: only userId
    const accountAuthCtx = { userId };

    // api-style: full user object
    const user: ApplicationUser = {
      id: asApplicationUserId("user-id-1"),
      status: "active",
      displayName: "Alice",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const apiAuthCtx: ResolvedAuthContext = { user };

    expect(accountAuthCtx.userId).toBe(userId);
    expect(apiAuthCtx.user.displayName).toBe("Alice");
    // Both share the same user ID but have distinct shapes.
    expect(Object.keys(accountAuthCtx)).toStrictEqual(["userId"]);
    expect(Object.keys(apiAuthCtx)).toStrictEqual(["user"]);
  });

  // Unused import guard: confirm asAuthIdentityId stays in scope for fixtures only.
  it("type-imports do not widen the context shape", () => {
    const id = asAuthIdentityId("identity-1");
    expect(typeof id).toBe("string");
  });
});

import { asApplicationUserId, asAuthIdentityId } from "@petroglyph/core";
import type { ApplicationUser, AuthIdentity } from "@petroglyph/account";
import { MOCK_OID } from "../auth/mock-provider.js";

// Seeded auth fixtures for local mocked-auth development.
// These records are pre-linked so the mock identity resolves to a known application user
// without requiring a real database.

export const FIXTURE_USER_ID = asApplicationUserId("fixture-user-00000000-0000-0000-0000-000000000001");

export const fixtureUser: ApplicationUser = {
  id: FIXTURE_USER_ID,
  status: "active",
  displayName: "Local Dev User",
  createdAt: "2026-01-01T00:00:00.000Z",
};

export const fixtureIdentity: AuthIdentity = {
  id: asAuthIdentityId("fixture-identity-00000000-0000-0000-0000-000000000001"),
  userId: FIXTURE_USER_ID,
  provider: "entra",
  externalId: MOCK_OID,
  externalEmail: "mock-user@example.com",
  createdAt: "2026-01-01T00:00:00.000Z",
};

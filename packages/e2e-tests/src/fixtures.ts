import type { SyncProfile } from "@petroglyph/core";
import type { TokenRecord } from "@petroglyph/core";

/**
 * The fixed identities the deployed smoke seeds. Deterministic values mean a
 * failed run leaves state the next run can find and clear.
 */
export const SMOKE_USER_ID = "smoke-user";
export const SMOKE_USERNAME = "smoke";
export const SMOKE_PROVIDER = "onedrive";
export const SMOKE_PROFILE_ID = "smoke-profile";
export const SMOKE_ITEM_ID = "smoke-item";
export const SMOKE_ITEM_NAME = "smoke.pdf";
export const SMOKE_RELATIVE_PATH = "notes";

export function createSmokeProfile(now: string): SyncProfile {
  return {
    profileId: SMOKE_PROFILE_ID,
    userId: SMOKE_USER_ID,
    name: "Deployed smoke",
    sourceFolderPath: SMOKE_RELATIVE_PATH,
    destinationVaultPath: "Petroglyph/Smoke",
    pollingIntervalMinutes: 5,
    enabled: true,
    active: true,
    initialSyncEnabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A valid access token: the adapter returns it without an OAuth round-trip,
 * so only Microsoft Graph is mocked. The refresh token exists so the shape is
 * real if the guard ever refreshes.
 */
export function createSmokeTokenVault(nowEpochSeconds: number): TokenRecord {
  return {
    accessToken: "smoke-access-token",
    refreshToken: "smoke-refresh-token",
    expirySeconds: nowEpochSeconds + 3600,
    updatedAt: new Date(nowEpochSeconds * 1000).toISOString(),
    reconnectRequired: false,
  };
}

export function smokeTrigger(): { userId: string; provider: string } {
  return { userId: SMOKE_USER_ID, provider: SMOKE_PROVIDER };
}

/** DynamoDB keys the runner resets before (and after) the journey. */
export function smokeResetKeys(): {
  syncProfile: { [key: string]: string };
  tokenVault: { [key: string]: string };
  deltaState: { [key: string]: string };
  stagedRecord: { [key: string]: string };
} {
  return {
    syncProfile: { userId: SMOKE_USER_ID, profileId: SMOKE_PROFILE_ID },
    tokenVault: { userId: SMOKE_USER_ID, provider: SMOKE_PROVIDER },
    deltaState: { userId: SMOKE_USER_ID, provider: SMOKE_PROVIDER },
    stagedRecord: { profileId: SMOKE_PROFILE_ID, itemId: SMOKE_ITEM_ID },
  };
}

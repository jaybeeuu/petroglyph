import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { defineEndpoint } from "@petroglyph/contracts/hono";
import {
  deleteProfile as deleteProfileOperation,
  getProfile as getProfileOperation,
  putProfile as putProfileOperation,
} from "@petroglyph/contracts/operations";
import type { EndpointInput } from "@petroglyph/contracts";
import {
  getProfile,
  listProfiles,
  normalizeSourceFolderPath,
  putProfile,
  deleteProfile,
} from "@petroglyph/core";
import type { SyncProfile } from "@petroglyph/core";
import type { MiddlewareHandler } from "hono";
import type { AppContext, AppVariables } from "./auth-middleware.js";
import { docClient } from "./db.js";
import type { ProfilePathReset } from "./profile-path-reset.js";

function syncProfilesTableName(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

function fileRecordsTableName(): string {
  return process.env["FILE_RECORDS_TABLE"] ?? "petroglyph-file-records-default";
}

/** The validated body of a profile update. */
type PutProfileBody = EndpointInput<(typeof putProfileOperation)["request"]>["body"];

async function deleteFileRecordsForProfile(profileId: string): Promise<void> {
  let lastEvaluatedKey: { [key: string]: unknown } | undefined;
  do {
    const result = await docClient().send(
      new QueryCommand({
        TableName: fileRecordsTableName(),
        KeyConditionExpression: "profileId = :profileId",
        ExpressionAttributeValues: { ":profileId": profileId },
        ExclusiveStartKey: lastEvaluatedKey,
        ProjectionExpression: "profileId, fileId",
      }),
    );
    for (const item of result.Items ?? []) {
      const itemProfileId = item["profileId"] as string;
      const fileId = item["fileId"] as string;
      await docClient().send(
        new DeleteCommand({
          TableName: fileRecordsTableName(),
          Key: { profileId: itemProfileId, fileId },
        }),
      );
    }
    lastEvaluatedKey = result.LastEvaluatedKey as { [key: string]: unknown } | undefined;
  } while (lastEvaluatedKey !== undefined);
}

/**
 * Has the profile's source folder really changed? The comparison is between
 * canonical forms, so a request that omits the field, repeats the stored path,
 * or differs only in trimming, a leading slash or a doubled slash is not a
 * change; anything that normalises to a different prefix is. The stored value
 * goes through the same normaliser, because a profile written before it
 * existed holds a form the walker never matches.
 */
function hasSourceFolderChanged(existing: SyncProfile, updates: PutProfileBody): boolean {
  if (updates.sourceFolderPath === undefined) {
    return false;
  }
  return (
    normalizeSourceFolderPath(updates.sourceFolderPath) !==
    normalizeSourceFolderPath(existing.sourceFolderPath)
  );
}

function mergeProfile(existing: SyncProfile, updates: PutProfileBody): SyncProfile {
  return {
    ...existing,
    ...(updates.name !== undefined && { name: updates.name }),
    ...(updates.sourceFolderPath !== undefined && {
      sourceFolderPath: normalizeSourceFolderPath(updates.sourceFolderPath),
    }),
    ...(updates.destinationVaultPath !== undefined && {
      destinationVaultPath: updates.destinationVaultPath,
    }),
    ...(updates.pollingIntervalMinutes !== undefined && {
      pollingIntervalMinutes: updates.pollingIntervalMinutes,
    }),
    ...(updates.enabled !== undefined && { enabled: updates.enabled }),
    ...(updates.initialSyncEnabled !== undefined && {
      initialSyncEnabled: updates.initialSyncEnabled,
    }),
    ...(updates.active !== undefined && { active: updates.active }),
    updatedAt: new Date().toISOString(),
  };
}

export const getProfileEndpoint = defineEndpoint(
  getProfileOperation,
  async (_input, c: AppContext) => {
    const userId = c.get("userId");
    const profileId = c.req.param("id") ?? "";
    const profile = await getProfile(docClient(), syncProfilesTableName(), userId, profileId);
    if (profile === null || profile.userId !== userId) {
      return c.json({ error: "Profile not found" }, 404);
    }
    return c.json(profile);
  },
);

/**
 * PUT /profiles/:id. `resetProfile` runs only when the source folder really
 * changed, and only after the profile carrying the marker is stored: the
 * marker is what keeps the reset owed, so a delete that fails below still
 * leaves a walk that re-enumerates. The request never walks the drive — the
 * reset discards staged state and bells the adapter, which keeps the response
 * short whatever the folder holds.
 */
export function createPutProfileEndpoint(
  resetProfile: ProfilePathReset,
): MiddlewareHandler<{ Variables: AppVariables }>[] {
  return defineEndpoint(putProfileOperation, async (input, c: AppContext) => {
    const userId = c.get("userId");
    const profileId = input.params.id;
    const existing = await getProfile(docClient(), syncProfilesTableName(), userId, profileId);
    if (existing === null || existing.userId !== userId) {
      return c.json({ error: "Profile not found" }, 404);
    }
    const updates = input.body;
    if (updates.active === false && existing.active) {
      return c.json(
        { error: "Cannot deactivate the active profile; activate another profile instead" },
        409,
      );
    }
    const sourceFolderChanged = hasSourceFolderChanged(existing, updates);
    const updated = mergeProfile(existing, updates);
    const stored: SyncProfile = sourceFolderChanged
      ? { ...updated, deltaResetPending: true }
      : updated;
    await putProfile(docClient(), syncProfilesTableName(), stored);
    if (sourceFolderChanged) {
      await resetProfile({ userId, profileId });
    }
    const deactivatedProfileIds: string[] = [];
    if (updates.active === true) {
      const profiles = await listProfiles(docClient(), syncProfilesTableName(), userId);
      for (const other of profiles) {
        if (other.profileId === profileId || !other.active) continue;
        await putProfile(docClient(), syncProfilesTableName(), {
          ...other,
          active: false,
          updatedAt: new Date().toISOString(),
        });
        deactivatedProfileIds.push(other.profileId);
      }
    }
    if (sourceFolderChanged && existing.active) {
      console.warn(
        `[profiles-crud] Profile ${profileId} is active and sourceFolderPath changed; Graph subscription update not yet implemented`,
      );
    }
    return c.json({ ...stored, deactivatedProfileIds });
  });
}

export const deleteProfileEndpoint = defineEndpoint(
  deleteProfileOperation,
  async (_input, c: AppContext) => {
    const userId = c.get("userId");
    const profileId = c.req.param("id") ?? "";
    const existing = await getProfile(docClient(), syncProfilesTableName(), userId, profileId);
    if (existing === null || existing.userId !== userId) {
      return c.json({ error: "Profile not found" }, 404);
    }
    await deleteProfile(docClient(), syncProfilesTableName(), userId, profileId);
    await deleteFileRecordsForProfile(profileId);
    if (existing.active) {
      const remaining = await listProfiles(docClient(), syncProfilesTableName(), userId);
      const others = remaining.filter((p) => p.profileId !== profileId);
      if (others.length > 0) {
        const newest = others.reduce((best: SyncProfile, p: SyncProfile) =>
          p.createdAt > best.createdAt ? p : best,
        );
        await putProfile(docClient(), syncProfilesTableName(), {
          ...newest,
          active: true,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return new Response(null, { status: 204 });
  },
);

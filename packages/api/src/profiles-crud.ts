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
  readProfileRow,
  softDeleteProfile,
  updateProfile,
} from "@petroglyph/core";
import type { SyncProfile } from "@petroglyph/core";
import type { AppContext } from "./auth-middleware.js";
import { docClient } from "./db.js";

function syncProfilesTableName(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

function fileRecordsTableName(): string {
  return process.env["FILE_RECORDS_TABLE"] ?? "petroglyph-file-records-default";
}

/** The validated body of a profile update. */
type PutProfileBody = EndpointInput<(typeof putProfileOperation)["request"]>["body"];

/**
 * The attributes a profile update writes. Built from the request, never from the
 * stored profile: `getProfile` parses the row with the domain schema, which
 * drops every attribute that schema does not model, so a write derived from the
 * parsed profile would delete them.
 */
type ProfileUpdate = Partial<
  Pick<
    SyncProfile,
    | "name"
    | "sourceFolderPath"
    | "destinationVaultPath"
    | "pollingIntervalMinutes"
    | "enabled"
    | "initialSyncEnabled"
    | "active"
  >
> & { updatedAt: string };

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

function profileUpdateFrom(body: PutProfileBody, updatedAt: string): ProfileUpdate {
  return {
    ...(body.name !== undefined && { name: body.name }),
    ...(body.sourceFolderPath !== undefined && {
      sourceFolderPath: normalizeSourceFolderPath(body.sourceFolderPath),
    }),
    ...(body.destinationVaultPath !== undefined && {
      destinationVaultPath: body.destinationVaultPath,
    }),
    ...(body.pollingIntervalMinutes !== undefined && {
      pollingIntervalMinutes: body.pollingIntervalMinutes,
    }),
    ...(body.enabled !== undefined && { enabled: body.enabled }),
    ...(body.initialSyncEnabled !== undefined && {
      initialSyncEnabled: body.initialSyncEnabled,
    }),
    ...(body.active !== undefined && { active: body.active }),
    updatedAt,
  };
}

/** The profile as the client sees it after the update is written. */
function mergeProfile(existing: SyncProfile, update: ProfileUpdate): SyncProfile {
  return { ...existing, ...update };
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

export const putProfileEndpoint = defineEndpoint(
  putProfileOperation,
  async (input, c: AppContext) => {
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
    const sourceFolderChanged =
      updates.sourceFolderPath !== undefined &&
      normalizeSourceFolderPath(updates.sourceFolderPath) !==
        normalizeSourceFolderPath(existing.sourceFolderPath);
    const update = profileUpdateFrom(updates, new Date().toISOString());
    await updateProfile(docClient(), syncProfilesTableName(), userId, profileId, update);
    const updated = mergeProfile(existing, update);
    const deactivatedProfileIds: string[] = [];
    if (updates.active === true) {
      const profiles = await listProfiles(docClient(), syncProfilesTableName(), userId);
      for (const other of profiles) {
        if (other.profileId === profileId || !other.active) continue;
        await updateProfile(docClient(), syncProfilesTableName(), userId, other.profileId, {
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
    return c.json({ ...updated, deactivatedProfileIds });
  },
);

export const deleteProfileEndpoint = defineEndpoint(
  deleteProfileOperation,
  async (_input, c: AppContext) => {
    const userId = c.get("userId");
    const profileId = c.req.param("id") ?? "";
    // The raw row, not getProfile: a profile that is already deleted answers 200
    // again rather than 404, and nothing is purged a second time.
    const existing = await readProfileRow(docClient(), syncProfilesTableName(), userId, profileId);
    if (existing === null || existing.userId !== userId) {
      return c.json({ error: "Profile not found" }, 404);
    }
    if (existing.deletedAt !== undefined) {
      return new Response(null, { status: 200 });
    }
    // Soft delete: the row keeps the intent and the profiles stream carries it
    // to the janitor, which purges the staged rows and their objects.
    await softDeleteProfile(
      docClient(),
      syncProfilesTableName(),
      userId,
      profileId,
      new Date().toISOString(),
    );
    // Legacy carve-out: the old processor's records are still cascaded here.
    await deleteFileRecordsForProfile(profileId);
    if (existing.active) {
      const remaining = await listProfiles(docClient(), syncProfilesTableName(), userId);
      const others = remaining.filter((p) => p.profileId !== profileId);
      if (others.length > 0) {
        const newest = others.reduce((best: SyncProfile, p: SyncProfile) =>
          p.createdAt > best.createdAt ? p : best,
        );
        await updateProfile(docClient(), syncProfilesTableName(), userId, newest.profileId, {
          active: true,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return new Response(null, { status: 200 });
  },
);

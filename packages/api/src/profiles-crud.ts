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
    const updated = mergeProfile(existing, updates);
    await putProfile(docClient(), syncProfilesTableName(), updated);
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
    return c.json({ ...updated, deactivatedProfileIds });
  },
);

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

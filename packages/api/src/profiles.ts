import { defineEndpoint } from "@petroglyph/contracts/hono";
import {
  createProfile as createProfileOperation,
  listProfiles as listProfilesOperation,
} from "@petroglyph/contracts/operations";
import { randomUUID } from "node:crypto";
import { listProfiles, normalizeSourceFolderPath, putProfile } from "@petroglyph/core";
import type { AppContext } from "./auth-middleware.js";
import { docClient } from "./db.js";

function syncProfilesTableName(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

export const listProfilesEndpoint = defineEndpoint(
  listProfilesOperation,
  async (_input, c: AppContext) => {
    const userId = c.get("userId");
    const profiles = await listProfiles(docClient(), syncProfilesTableName(), userId);
    return c.json(profiles);
  },
);

export const createProfileEndpoint = defineEndpoint(
  createProfileOperation,
  async (input, c: AppContext) => {
    const userId = c.get("userId");
    const existingProfiles = await listProfiles(docClient(), syncProfilesTableName(), userId);
    const isFirst = existingProfiles.length === 0;
    const now = new Date().toISOString();
    const profile = {
      profileId: randomUUID(),
      userId,
      name: input.body.name,
      sourceFolderPath: normalizeSourceFolderPath(input.body.sourceFolderPath),
      destinationVaultPath: input.body.destinationVaultPath,
      pollingIntervalMinutes: input.body.pollingIntervalMinutes ?? 5,
      enabled: input.body.enabled ?? true,
      active: isFirst,
      initialSyncEnabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await putProfile(docClient(), syncProfilesTableName(), profile);
    return c.json(profile, 201);
  },
);

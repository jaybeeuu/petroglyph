import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { listProfiles, putProfile } from "@petroglyph/core";
import { docClient } from "./db.js";

function syncProfilesTableName(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

const createProfileBodySchema = z.object({
  name: z.string().min(1),
  sourceFolderPath: z.string().min(1),
  destinationVaultPath: z.string().min(1),
  pollingIntervalMinutes: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

export async function handleListProfiles(c: Context): Promise<Response> {
  const userId = c.get("userId") as string;
  const profiles = await listProfiles(docClient, syncProfilesTableName(), userId);
  return c.json(profiles);
}

export async function handleCreateProfile(c: Context): Promise<Response> {
  const userId = c.get("userId") as string;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const parsed = createProfileBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid profile data", details: parsed.error.issues }, 400);
  }

  const existingProfiles = await listProfiles(docClient, syncProfilesTableName(), userId);
  const isFirst = existingProfiles.length === 0;

  const now = new Date().toISOString();
  const profile = {
    profileId: randomUUID(),
    userId,
    name: parsed.data.name,
    sourceFolderPath: parsed.data.sourceFolderPath,
    destinationVaultPath: parsed.data.destinationVaultPath,
    pollingIntervalMinutes: parsed.data.pollingIntervalMinutes ?? 5,
    enabled: parsed.data.enabled ?? true,
    active: isFirst,
    createdAt: now,
    updatedAt: now,
  };

  await putProfile(docClient, syncProfilesTableName(), profile);

  return c.json(profile, 201);
}

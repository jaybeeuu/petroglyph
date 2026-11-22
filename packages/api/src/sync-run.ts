import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { listProfiles } from "@petroglyph/core";
import { defineEndpoint } from "@petroglyph/contracts/hono";
import { runSync } from "@petroglyph/contracts/operations";
import type { AppContext } from "./auth-middleware.js";
import { randomUUID } from "node:crypto";
import { docClient } from "./db.js";

function syncProfilesTableName(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

function syncJobsTableName(): string {
  return process.env["SYNC_JOBS_TABLE"] ?? "petroglyph-sync-jobs-default";
}

async function findActiveProfile(
  userId: string,
): Promise<{ sourceFolderPath: string; profileId: string } | null> {
  try {
    // The store drops a soft-deleted profile, so this reader cannot dispatch a
    // sync for one. Parse failures come back as an error and answer "no active
    // profile" rather than walking a half-read row.
    const profiles = await listProfiles(docClient(), syncProfilesTableName(), userId);

    const active = profiles.find((profile) => profile.active);
    if (active) {
      return { sourceFolderPath: active.sourceFolderPath, profileId: active.profileId };
    }
    return null;
  } catch {
    return null;
  }
}

async function createSyncJob(
  jobId: string,
  userId: string,
  profileId: string,
  sourceFolderPath: string,
): Promise<void> {
  const createdAt = new Date().toISOString();
  await docClient().send(
    new PutCommand({
      TableName: syncJobsTableName(),
      Item: {
        jobId,
        userId,
        profileId,
        sourceFolderPath,
        status: "queued",
        createdAt,
        // DynamoDB TTL expects epoch seconds. A healthy job is picked up within
        // ~5-30s, so 5 minutes is a ~10x margin: stuck jobs are chopped (and
        // retried via the relay backstop) without ever chopping healthy ones.
        expiresAt: Math.floor(new Date(createdAt).getTime() / 1000) + 5 * 60,
        retryCount: 0,
      },
    }),
  );
}

export const runSyncEndpoint = defineEndpoint(runSync, async (_input, c: AppContext) => {
  const userIdValue: unknown = c.get("userId");
  if (typeof userIdValue !== "string" || userIdValue.length === 0) {
    throw new Error("Missing userId in sync run context");
  }
  const userId = userIdValue;

  const activeProfile = await findActiveProfile(userId);
  if (!activeProfile) {
    return c.json({ error: "No active profile configured" }, 400);
  }

  const jobId = randomUUID();
  await createSyncJob(jobId, userId, activeProfile.profileId, activeProfile.sourceFolderPath);

  return c.json({ jobId }, 201);
});

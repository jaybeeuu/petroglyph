import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { syncProfileSchema } from "@petroglyph/core";
import type { SyncProfile } from "@petroglyph/core";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { docClient } from "./db.js";

function syncProfilesTableName(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

function syncJobsTableName(): string {
  return process.env["SYNC_JOBS_TABLE"] ?? "petroglyph-sync-jobs-default";
}

function parseSyncProfile(item: unknown): SyncProfile | null {
  const parsed = syncProfileSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

async function findActiveProfile(
  userId: string,
): Promise<{ sourceFolderPath: string; profileId: string } | null> {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: syncProfilesTableName(),
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
      }),
    );

    const profiles = (result.Items ?? [])
      .map(parseSyncProfile)
      .filter((p): p is SyncProfile => p !== null);

    const active = profiles.find((p) => p.active);
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
  await docClient.send(
    new PutCommand({
      TableName: syncJobsTableName(),
      Item: {
        jobId,
        userId,
        profileId,
        sourceFolderPath,
        status: "queued",
        createdAt: new Date().toISOString(),
      },
    }),
  );
}

export async function handleSyncRun(c: Context): Promise<Response> {
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
}

import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { docClient } from "./db.js";

function syncProfilesTableName(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

function syncJobsTableName(): string {
  return process.env["SYNC_JOBS_TABLE"] ?? "petroglyph-sync-jobs-default";
}

interface SyncProfile {
  profileId: string;
  userId: string;
  sourceFolderPath: string;
  active?: boolean;
}

function parseSyncProfile(item: unknown): SyncProfile | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }

  const record = item as { [key: string]: unknown };
  const profileId = record["profileId"];
  const userId = record["userId"];
  const sourceFolderPath = record["sourceFolderPath"];

  if (
    typeof profileId !== "string" ||
    typeof userId !== "string" ||
    typeof sourceFolderPath !== "string"
  ) {
    return null;
  }

  return {
    profileId,
    userId,
    sourceFolderPath,
    active: record["active"] === true,
  };
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

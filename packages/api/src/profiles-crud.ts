import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { z } from "zod";
import { getProfile, listProfiles, putProfile, deleteProfile } from "@petroglyph/core";
import type { SyncProfile } from "@petroglyph/core";
import type { AppVariables } from "./auth-middleware.js";
import { docClient } from "./db.js";

function syncProfilesTableName(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

function fileRecordsTableName(): string {
  return process.env["FILE_RECORDS_TABLE"] ?? "petroglyph-file-records-default";
}

const putProfileBodySchema = z.object({
  name: z.string().min(1).optional(),
  sourceFolderPath: z.string().min(1).optional(),
  destinationVaultPath: z.string().min(1).optional(),
  pollingIntervalMinutes: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

async function deleteFileRecordsForProfile(profileId: string): Promise<void> {
  let lastEvaluatedKey: { [key: string]: unknown } | undefined;

  do {
    const result = await docClient.send(
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
      await docClient.send(
        new DeleteCommand({
          TableName: fileRecordsTableName(),
          Key: { profileId: itemProfileId, fileId },
        }),
      );
    }

    lastEvaluatedKey = result.LastEvaluatedKey as { [key: string]: unknown } | undefined;
  } while (lastEvaluatedKey !== undefined);
}

function mergeProfile(
  existing: SyncProfile,
  updates: z.infer<typeof putProfileBodySchema>,
): SyncProfile {
  return {
    ...existing,
    ...(updates.name !== undefined && { name: updates.name }),
    ...(updates.sourceFolderPath !== undefined && { sourceFolderPath: updates.sourceFolderPath }),
    ...(updates.destinationVaultPath !== undefined && {
      destinationVaultPath: updates.destinationVaultPath,
    }),
    ...(updates.pollingIntervalMinutes !== undefined && {
      pollingIntervalMinutes: updates.pollingIntervalMinutes,
    }),
    ...(updates.enabled !== undefined && { enabled: updates.enabled }),
    updatedAt: new Date().toISOString(),
  };
}

export async function handleGetProfile(
  c: Context<{ Variables: AppVariables }>,
): Promise<Response> {
  const userId = c.get("userId");
  const profileId = c.req.param("id") ?? "";

  const profile = await getProfile(docClient, syncProfilesTableName(), userId, profileId);

  if (profile === null || profile.userId !== userId) {
    return c.json({ error: "Profile not found" }, 404);
  }

  return c.json(profile);
}

export async function handlePutProfile(
  c: Context<{ Variables: AppVariables }>,
): Promise<Response> {
  const userId = c.get("userId");
  const profileId = c.req.param("id") ?? "";

  const existing = await getProfile(docClient, syncProfilesTableName(), userId, profileId);

  if (existing === null || existing.userId !== userId) {
    return c.json({ error: "Profile not found" }, 404);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = putProfileBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const updates = parsed.data;
  const sourceFolderChanged =
    updates.sourceFolderPath !== undefined &&
    updates.sourceFolderPath !== existing.sourceFolderPath;

  const updated = mergeProfile(existing, updates);

  await putProfile(docClient, syncProfilesTableName(), updated);

  if (sourceFolderChanged && existing.active) {
    console.warn(
      `[profiles-crud] Profile ${profileId} is active and sourceFolderPath changed; Graph subscription update not yet implemented`,
    );
  }

  return c.json(updated);
}

export async function handleDeleteProfile(
  c: Context<{ Variables: AppVariables }>,
): Promise<Response> {
  const userId = c.get("userId");
  const profileId = c.req.param("id") ?? "";

  const existing = await getProfile(docClient, syncProfilesTableName(), userId, profileId);

  if (existing === null || existing.userId !== userId) {
    return c.json({ error: "Profile not found" }, 404);
  }

  await deleteProfile(docClient, syncProfilesTableName(), userId, profileId);
  await deleteFileRecordsForProfile(profileId);

  if (existing.active) {
    const remaining = await listProfiles(docClient, syncProfilesTableName(), userId);
    const others = remaining.filter((p) => p.profileId !== profileId);

    if (others.length > 0) {
      const newest = others.reduce((best: SyncProfile, p: SyncProfile) =>
        p.createdAt > best.createdAt ? p : best,
      );
      await putProfile(docClient, syncProfilesTableName(), {
        ...newest,
        active: true,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return new Response(null, { status: 204 });
}


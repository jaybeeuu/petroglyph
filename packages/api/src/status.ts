import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import type { AppVariables } from "./auth-middleware.js";
import { docClient } from "./db.js";

export interface StatusResponse {
  github: { connected: boolean; username?: string };
  oneDrive: { connected: boolean };
}

function syncProfilesTable(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

async function fetchOneDriveConnected(userId: string): Promise<boolean> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: syncProfilesTable(),
        Key: { userId, profileId: "default" },
      }),
    );
    return result.Item?.["oneDriveConnected"] === true;
  } catch (err) {
    console.error("[status] Failed to fetch SyncProfile from DynamoDB", err);
    return false;
  }
}

export async function handleStatus(
  c: Context<{ Variables: AppVariables }>,
): Promise<Response> {
  const username = c.get("username");
  const userId = c.get("userId");

  const oneDriveConnected = await fetchOneDriveConnected(userId);

  const body: StatusResponse = {
    github: { connected: true, username },
    oneDrive: { connected: oneDriveConnected },
  };

  return c.json(body);
}

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import type { AppVariables } from "./auth-middleware.js";
import { docClient } from "./db.js";

export type OneDriveStatus =
  | "connected"
  | "disconnected"
  | "never_connected"
  | "reconnect_required";

export interface StatusResponse {
  github: { connected: boolean; username?: string };
  oneDrive: { connected: boolean };
  oneDriveStatus: OneDriveStatus;
}

function syncProfilesTable(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

function usersTable(): string {
  return process.env["USERS_TABLE"] ?? "petroglyph-users-default";
}

interface UserStatusRecord {
  oneDriveStatus?: string;
}

interface SyncProfileStatus {
  exists: boolean;
  oneDriveConnected: boolean;
}

function parseUserStatus(item: unknown): UserStatusRecord {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return {};
  }

  const value = item as { [key: string]: unknown };
  return typeof value["oneDriveStatus"] === "string"
    ? { oneDriveStatus: value["oneDriveStatus"] }
    : {};
}

function parseSyncProfileStatus(item: unknown): SyncProfileStatus {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return { exists: false, oneDriveConnected: false };
  }

  const value = item as { [key: string]: unknown };
  return {
    exists: true,
    oneDriveConnected: value["oneDriveConnected"] === true,
  };
}

async function fetchSyncProfileStatus(userId: string): Promise<SyncProfileStatus> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: syncProfilesTable(),
        Key: { userId, profileId: "default" },
      }),
    );
    return parseSyncProfileStatus(result.Item);
  } catch (err) {
    console.error("[status] Failed to fetch SyncProfile from DynamoDB", err);
    return { exists: false, oneDriveConnected: false };
  }
}

async function fetchStoredReconnectRequired(userId: string): Promise<boolean> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: usersTable(),
        Key: { userId },
      }),
    );
    const { oneDriveStatus } = parseUserStatus(result.Item);

    if (
      oneDriveStatus === "reconnect_required" ||
      oneDriveStatus === "disconnected"
    ) {
      return true;
    }
    return false;
  } catch (err) {
    console.error("[status] Failed to fetch user record from DynamoDB", err);
    return false;
  }
}

export async function handleStatus(
  c: Context<{ Variables: AppVariables }>,
): Promise<Response> {
  const username = c.get("username");
  const userId = c.get("userId");

  const [syncProfileStatus, storedReconnectRequired] = await Promise.all([
    fetchSyncProfileStatus(userId),
    fetchStoredReconnectRequired(userId),
  ]);
  const oneDriveStatus = syncProfileStatus.oneDriveConnected
    ? "connected"
    : storedReconnectRequired || syncProfileStatus.exists
      ? "reconnect_required"
      : "never_connected";

  const body: StatusResponse = {
    github: { connected: true, username },
    oneDrive: {
      connected:
        oneDriveStatus === "connected" && syncProfileStatus.oneDriveConnected,
    },
    oneDriveStatus,
  };

  return c.json(body);
}

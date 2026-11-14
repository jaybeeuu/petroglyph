import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { defineEndpoint } from "@petroglyph/contracts/hono";
import { getStatus } from "@petroglyph/contracts/operations";
import type { AppContext } from "./auth-middleware.js";
import { docClient } from "./db.js";

export type OneDriveStatus =
  | "connected"
  | "connected_no_profile"
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

function parseSyncProfileStatus(items: unknown[]): SyncProfileStatus {
  let exists = false;
  let oneDriveConnected = false;

  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    exists = true;
    if ((item as { [key: string]: unknown })["oneDriveConnected"] === true) {
      oneDriveConnected = true;
    }
  }

  return { exists, oneDriveConnected };
}

async function fetchSyncProfileStatus(userId: string): Promise<SyncProfileStatus> {
  try {
    const result = await docClient().send(
      new QueryCommand({
        TableName: syncProfilesTable(),
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
      }),
    );
    return parseSyncProfileStatus(result.Items ?? []);
  } catch (err) {
    console.error("[status] Failed to fetch SyncProfiles from DynamoDB", err);
    return { exists: false, oneDriveConnected: false };
  }
}

async function fetchUserStatus(userId: string): Promise<UserStatusRecord> {
  try {
    const result = await docClient().send(
      new GetCommand({
        TableName: usersTable(),
        Key: { userId },
      }),
    );
    return parseUserStatus(result.Item);
  } catch (err) {
    console.error("[status] Failed to fetch user record from DynamoDB", err);
    return {};
  }
}

export const getStatusEndpoint = defineEndpoint(getStatus, async (_input, c: AppContext) => {
  const username = c.get("username");
  const userId = c.get("userId");

  const [syncProfileStatus, userStatus] = await Promise.all([
    fetchSyncProfileStatus(userId),
    fetchUserStatus(userId),
  ]);
  const storedReconnectRequired =
    userStatus.oneDriveStatus === "reconnect_required" ||
    userStatus.oneDriveStatus === "disconnected";
  const connectionConnected = userStatus.oneDriveStatus === "connected";

  // The user record is the connection authority: connect and the lifecycle
  // events write it. A profile flag is the legacy fallback for a user whose
  // record predates it. A live connection with no profile is its own state, so
  // the plugin can prompt for one without claiming a sync.
  const oneDriveStatus: OneDriveStatus = storedReconnectRequired
    ? "reconnect_required"
    : connectionConnected
      ? syncProfileStatus.exists
        ? "connected"
        : "connected_no_profile"
      : !syncProfileStatus.exists
        ? "never_connected"
        : syncProfileStatus.oneDriveConnected
          ? "connected"
          : "reconnect_required";

  const body: StatusResponse = {
    github: { connected: true, username },
    oneDrive: {
      connected: oneDriveStatus === "connected" || oneDriveStatus === "connected_no_profile",
    },
    oneDriveStatus,
  };

  return c.json(body);
});

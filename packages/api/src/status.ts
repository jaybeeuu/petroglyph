import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { defineEndpoint } from "@petroglyph/contracts/hono";
import { getStatus } from "@petroglyph/contracts/operations";
import type { TokenRecord } from "@petroglyph/core";
import type { AppContext } from "./auth-middleware.js";
import { docClient } from "./db.js";
import { ONEDRIVE_PROVIDER, readConnection } from "./token-vault.js";

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

function parseUserStatus(item: unknown): UserStatusRecord {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return {};
  }

  const value = item as { [key: string]: unknown };
  return typeof value["oneDriveStatus"] === "string"
    ? { oneDriveStatus: value["oneDriveStatus"] }
    : {};
}

/**
 * The stored connection, or null when onboarding never completed. This is the
 * authority for the connection state; a profile says nothing about it.
 */
async function fetchConnection(userId: string): Promise<TokenRecord | null> {
  try {
    return await readConnection(docClient(), userId, ONEDRIVE_PROVIDER);
  } catch (err) {
    console.error("[status] Failed to read the OneDrive connection", err);
    return null;
  }
}

/**
 * Whether the user has created a profile yet. Presence is the only profile fact
 * `/status` reads: it selects the no-profile sub-state and never the connection
 * state, so a stale attribute on a profile cannot change the answer.
 */
async function hasProfile(userId: string): Promise<boolean> {
  try {
    const result = await docClient().send(
      new QueryCommand({
        TableName: syncProfilesTable(),
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
        Select: "COUNT",
        Limit: 1,
      }),
    );
    return (result.Count ?? 0) > 0;
  } catch (err) {
    // Unknown, so do not invent a profile for the user to create: report the
    // connection alone and let the profiles section speak for itself.
    console.error("[status] Failed to count SyncProfiles in DynamoDB", err);
    return true;
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

  const [connection, userStatus, profileExists] = await Promise.all([
    fetchConnection(userId),
    fetchUserStatus(userId),
    hasProfile(userId),
  ]);

  // The connection is the only authority: the vault row holds the grant and
  // whether it died, and the user record holds the lifecycle mark. A profile
  // contributes presence and nothing else, so no profile attribute can flip a
  // connected user to reconnect_required or the reverse.
  const reconnectRequired =
    connection?.reconnectRequired === true ||
    userStatus.oneDriveStatus === "reconnect_required" ||
    userStatus.oneDriveStatus === "disconnected";
  const hasConnection = connection !== null || userStatus.oneDriveStatus === "connected";

  // A live connection with no profile is its own state, so the plugin prompts
  // for one instead of claiming a sync.
  const oneDriveStatus: OneDriveStatus = reconnectRequired
    ? "reconnect_required"
    : !hasConnection
      ? "never_connected"
      : profileExists
        ? "connected"
        : "connected_no_profile";

  const body: StatusResponse = {
    github: { connected: true, username },
    oneDrive: {
      connected: oneDriveStatus === "connected" || oneDriveStatus === "connected_no_profile",
    },
    oneDriveStatus,
  };

  return c.json(body);
});

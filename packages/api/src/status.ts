import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { defineEndpoint } from "@petroglyph/contracts/hono";
import { getStatus } from "@petroglyph/contracts/operations";
import type { TokenRecord } from "@petroglyph/core";
import type { AppContext } from "./auth-middleware.js";
import { docClient } from "./db.js";
import { ONEDRIVE_PROVIDER, readConnection } from "./token-vault.js";
import { usersTableName } from "./user-record.js";

export type OneDriveStatus =
  | "connected"
  | "connected_no_profile"
  | "never_connected"
  | "reconnect_required";

export interface StatusResponse {
  github: { connected: boolean; username?: string };
  oneDrive: { connected: boolean };
  oneDriveStatus: OneDriveStatus;
}

interface UserStatusRecord {
  oneDriveStatus?: string;
  hasProfile?: boolean;
}

function parseUserStatus(item: unknown): UserStatusRecord {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return {};
  }

  const value = item as { [key: string]: unknown };
  const oneDriveStatus =
    typeof value["oneDriveStatus"] === "string" ? value["oneDriveStatus"] : undefined;
  const hasProfile = typeof value["hasProfile"] === "boolean" ? value["hasProfile"] : undefined;

  return {
    ...(oneDriveStatus !== undefined && { oneDriveStatus }),
    ...(hasProfile !== undefined && { hasProfile }),
  };
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

async function fetchUserStatus(userId: string): Promise<UserStatusRecord> {
  try {
    const result = await docClient().send(
      new GetCommand({
        TableName: usersTableName(),
        Key: { userId },
      }),
    );
    return parseUserStatus(result.Item);
  } catch (err) {
    console.error("[status] Failed to fetch user record from DynamoDB", err);
    // Unknown, so report presence: a failed read must never tell a user to
    // create a profile they may already have.
    return { hasProfile: true };
  }
}

export const getStatusEndpoint = defineEndpoint(getStatus, async (_input, c: AppContext) => {
  const username = c.get("username");
  const userId = c.get("userId");

  const [connection, userStatus] = await Promise.all([
    fetchConnection(userId),
    fetchUserStatus(userId),
  ]);

  // The connection is the only authority: the vault row holds the grant and
  // whether it died, and the user record holds the lifecycle mark. Profile
  // presence is the user record's own mark, so no profile row is read and no
  // profile attribute can flip a connected user to reconnect_required or the
  // reverse.
  const reconnectRequired =
    connection?.reconnectRequired === true || userStatus.oneDriveStatus === "reconnect_required";
  const hasConnection = connection !== null || userStatus.oneDriveStatus === "connected";

  // A live connection with no profile is its own state, so the plugin prompts
  // for one instead of claiming a sync.
  const oneDriveStatus: OneDriveStatus = reconnectRequired
    ? "reconnect_required"
    : !hasConnection
      ? "never_connected"
      : userStatus.hasProfile === true
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

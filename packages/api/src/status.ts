import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { defineEndpoint } from "@petroglyph/contracts/hono";
import { getStatus } from "@petroglyph/contracts/operations";
import { isDeletedProfile, listProfiles } from "@petroglyph/core";
import type { AppContext } from "./auth-middleware.js";
import { docClient } from "./db.js";
import { readSubscriptionState } from "./subscriptions.js";
import { syncProfilesTableName } from "./tables.js";

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

interface SyncProfileStatus {
  exists: boolean;
  oneDriveConnected: boolean;
}

/** What the subscription registry says about a connection's live profiles. */
interface SubscriptionSummary {
  liveProfiles: number;
  failedProfiles: number;
  activeProfiles: number;
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
    const result = await docClient().send(
      new GetCommand({
        TableName: syncProfilesTableName(),
        Key: { userId, profileId: "default" },
      }),
    );
    return parseSyncProfileStatus(result.Item);
  } catch (err) {
    console.error("[status] Failed to fetch SyncProfile from DynamoDB", err);
    return { exists: false, oneDriveConnected: false };
  }
}

/**
 * The profiles a connection still serves. A profile carrying `deletedAt` is
 * gone, so its subscription says nothing about the connection.
 */
async function fetchLiveProfileIds(userId: string): Promise<string[]> {
  try {
    const profiles = await listProfiles(docClient(), syncProfilesTableName(), userId);
    return profiles
      .filter((profile) => !isDeletedProfile(profile))
      .map((profile) => profile.profileId);
  } catch (err) {
    console.error("[status] Failed to list SyncProfiles from DynamoDB", err);
    return [];
  }
}

async function summariseSubscriptions(profileIds: string[]): Promise<SubscriptionSummary> {
  try {
    const states = await Promise.all(profileIds.map(readSubscriptionState));
    return {
      liveProfiles: profileIds.length,
      failedProfiles: states.filter((state) => state === "failed").length,
      activeProfiles: states.filter((state) => state === "active").length,
    };
  } catch (err) {
    console.error("[status] Failed to read subscription states from DynamoDB", err);
    return { liveProfiles: 0, failedProfiles: 0, activeProfiles: 0 };
  }
}

/**
 * `reconnect_required` is derived, never stored: a connection needs reconnect
 * only when every one of its live profiles' subscriptions has failed, and one
 * active subscription clears it. When the registry has nothing to say, the
 * stored connection marker answers as it always has.
 */
function deriveOneDriveStatus(options: {
  summary: SubscriptionSummary;
  syncProfileStatus: SyncProfileStatus;
}): OneDriveStatus {
  const { summary, syncProfileStatus } = options;

  if (summary.liveProfiles > 0 && summary.failedProfiles === summary.liveProfiles) {
    return "reconnect_required";
  }
  if (summary.activeProfiles > 0) {
    return "connected";
  }
  if (syncProfileStatus.oneDriveConnected) {
    return "connected";
  }
  return syncProfileStatus.exists ? "reconnect_required" : "never_connected";
}

export const getStatusEndpoint = defineEndpoint(getStatus, async (_input, c: AppContext) => {
  const username = c.get("username");
  const userId = c.get("userId");

  const [syncProfileStatus, liveProfileIds] = await Promise.all([
    fetchSyncProfileStatus(userId),
    fetchLiveProfileIds(userId),
  ]);
  const summary = await summariseSubscriptions(liveProfileIds);
  const oneDriveStatus = deriveOneDriveStatus({ summary, syncProfileStatus });

  const body: StatusResponse = {
    github: { connected: true, username },
    oneDrive: { connected: oneDriveStatus === "connected" },
    oneDriveStatus,
  };

  return c.json(body);
});

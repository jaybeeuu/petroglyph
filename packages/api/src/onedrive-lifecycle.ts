import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { docClient } from "./db.js";

function usersTable(): string {
  return process.env["USERS_TABLE"] ?? "petroglyph-users-default";
}

function refreshTokensTable(): string {
  return process.env["REFRESH_TOKENS_TABLE"] ?? "petroglyph-refresh_tokens-default";
}

interface LifecycleNotification {
  lifecycleEvent: string;
  clientState: string;
  subscriptionId?: string;
}

type OneDriveStatus = "connected" | "reconnect_required";

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRefreshToken(item: unknown, userId: string): string {
  if (
    !isRecord(item) ||
    typeof item["refreshToken"] !== "string" ||
    item["refreshToken"].length === 0
  ) {
    throw new Error(`Refresh token missing for user ${userId}`);
  }
  return item["refreshToken"];
}

function parseLifecycleNotifications(body: unknown): LifecycleNotification[] {
  if (!isRecord(body) || !Array.isArray(body["value"])) {
    return [];
  }

  return body["value"].flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["lifecycleEvent"] !== "string" ||
      typeof entry["clientState"] !== "string"
    ) {
      return [];
    }
    return [
      {
        lifecycleEvent: entry["lifecycleEvent"],
        clientState: entry["clientState"],
        ...(typeof entry["subscriptionId"] === "string"
          ? { subscriptionId: entry["subscriptionId"] }
          : {}),
      },
    ];
  });
}

async function updateOneDriveStatus(userId: string, status: OneDriveStatus): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: usersTable(),
      Key: { userId },
      UpdateExpression: "SET oneDriveStatus = :status, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":status": status,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );
}

async function markConnected(userId: string): Promise<void> {
  await updateOneDriveStatus(userId, "connected");
}

async function markReconnectRequired(userId: string): Promise<void> {
  await updateOneDriveStatus(userId, "reconnect_required");
}

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function reauthorizeGraphSubscription(
  subscriptionId: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}/reauthorize`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Graph subscription reauthorize failed: ${response.status} ${response.statusText}`);
  }
}

function parseMicrosoftTokenResponse(value: unknown): MicrosoftTokenResponse {
  if (!isRecord(value)) {
    throw new Error("Microsoft token response is not an object");
  }
  if (typeof value["access_token"] !== "string") {
    throw new Error("Microsoft token response missing string access_token");
  }
  if (typeof value["refresh_token"] !== "string") {
    throw new Error("Microsoft token response missing string refresh_token");
  }
  if (typeof value["expires_in"] !== "number") {
    throw new Error("Microsoft token response missing number expires_in");
  }
  return {
    access_token: value["access_token"],
    refresh_token: value["refresh_token"],
    expires_in: value["expires_in"],
  };
}

async function refreshUserToken(refreshToken: string): Promise<MicrosoftTokenResponse> {
  const clientId = process.env["MICROSOFT_CLIENT_ID"];
  if (!clientId) throw new Error("MICROSOFT_CLIENT_ID env var not set");
  const clientSecret = process.env["MICROSOFT_CLIENT_SECRET"];
  if (!clientSecret) throw new Error("MICROSOFT_CLIENT_SECRET env var not set");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "files.read offline_access",
  });

  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Microsoft token refresh failed with status ${response.status}`);
  }

  return parseMicrosoftTokenResponse(await response.json());
}

async function storeUserTokens(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): Promise<void> {
  const expirySeconds = Math.floor(Date.now() / 1000) + expiresIn;
  await docClient.send(
    new UpdateCommand({
      TableName: refreshTokensTable(),
      Key: { tokenHash: userId },
      UpdateExpression:
        "SET accessToken = :accessToken, refreshToken = :refreshToken, expirySeconds = :expirySeconds, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":accessToken": accessToken,
        ":refreshToken": refreshToken,
        ":expirySeconds": expirySeconds,
        ":updatedAt": new Date().toISOString(),
      },
    }),
  );
}

async function handleReauthorizationRequired(notification: LifecycleNotification): Promise<void> {
  if (!notification.subscriptionId) {
    throw new Error("Lifecycle notification missing subscriptionId");
  }

  const refreshTokenResult = await docClient.send(
    new GetCommand({
      TableName: refreshTokensTable(),
      Key: { tokenHash: notification.clientState },
    }),
  );
  const refreshToken = parseRefreshToken(
    refreshTokenResult.Item as unknown,
    notification.clientState,
  );
  const refreshed = await refreshUserToken(refreshToken);
  await storeUserTokens(
    notification.clientState,
    refreshed.access_token,
    refreshed.refresh_token,
    refreshed.expires_in,
  );
  await reauthorizeGraphSubscription(notification.subscriptionId, refreshed.access_token);
  await markConnected(notification.clientState);
}

async function processLifecycleNotification(notification: LifecycleNotification): Promise<void> {
  if (notification.lifecycleEvent === "subscriptionRemoved") {
    await markReconnectRequired(notification.clientState);
    return;
  }

  if (notification.lifecycleEvent === "reauthorizationRequired") {
    try {
      await handleReauthorizationRequired(notification);
    } catch (error) {
      console.error("[onedrive-lifecycle] reauthorization failed:", error);
      await markReconnectRequired(notification.clientState);
    }
  }
}

async function processLifecycleNotifications(
  notifications: LifecycleNotification[],
): Promise<void> {
  await Promise.all(
    notifications.map((notification) => processLifecycleNotification(notification)),
  );
}

export async function handleOnedriveLifecycle(c: Context): Promise<Response> {
  const validationToken = c.req.query("validationToken");
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const notifications = parseLifecycleNotifications(await c.req.json().catch(() => null));
  await processLifecycleNotifications(notifications).catch((error: unknown) => {
    console.error("[onedrive-lifecycle] lifecycle processing failed:", error);
  });

  return c.body(null, 202);
}

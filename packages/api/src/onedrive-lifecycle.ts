import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { defineEndpoint } from "@petroglyph/contracts/hono";
import { postOnedriveLifecycle } from "@petroglyph/contracts/operations";
import { OAuthTokenResolver, type TokenRequestOutcome } from "@petroglyph/core";
import type { AppContext } from "./auth-middleware.js";
import { docClient } from "./db.js";
import { ONEDRIVE_PROVIDER, connectionTokenStore } from "./token-vault.js";

function usersTable(): string {
  return process.env["USERS_TABLE"] ?? "petroglyph-users-default";
}

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

interface LifecycleNotification {
  lifecycleEvent: string;
  clientState: string;
  subscriptionId?: string;
}

type OneDriveStatus = "connected" | "reconnect_required";

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  await docClient().send(
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

export async function markConnected(userId: string): Promise<void> {
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
    throw new Error(
      `Graph subscription reauthorize failed: ${response.status} ${response.statusText}`,
    );
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

/**
 * Rotates the connection's grant with Microsoft. A dead grant is an outcome,
 * not a crash: `invalid_grant` is what the resolver turns into the sticky
 * `reconnectRequired` flag it shares with the OneDrive adapter.
 */
async function requestMicrosoftTokens(refreshToken: string): Promise<TokenRequestOutcome> {
  const clientId = process.env["MICROSOFT_CLIENT_ID"];
  if (!clientId) throw new Error("MICROSOFT_CLIENT_ID env var not set");
  const clientSecret = process.env["MICROSOFT_CLIENT_SECRET"];
  if (!clientSecret) throw new Error("MICROSOFT_CLIENT_SECRET env var not set");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "files.readwrite offline_access",
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => undefined);
    if (isRecord(error) && error["error"] === "invalid_grant") {
      return { kind: "grant-invalid" };
    }
    throw new Error(`Microsoft token refresh failed with status ${response.status}`);
  }

  const tokens = parseMicrosoftTokenResponse(await response.json());
  return {
    kind: "success",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  };
}

/**
 * The API's door to the connection vault. Refreshing through it — rather than
 * through a second copy of the grant — is what keeps a rotation visible to the
 * adapter, which resolves its grant from the same row.
 */
function createConnectionTokenResolver(): OAuthTokenResolver {
  return new OAuthTokenResolver({
    store: connectionTokenStore(docClient()),
    now: () => Math.floor(Date.now() / 1000),
    requestTokens: requestMicrosoftTokens,
  });
}

async function deleteGraphSubscription(subscriptionId: string, accessToken: string): Promise<void> {
  const response = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 404) {
    return;
  }
  if (!response.ok) {
    console.warn(
      `[onedrive-lifecycle] Graph subscription delete failed: ${response.status} ${response.statusText}`,
    );
  }
}

interface GraphDriveResponse {
  id: string;
}

function isGraphDriveResponse(value: unknown): value is GraphDriveResponse {
  return isRecord(value) && typeof value["id"] === "string";
}

async function fetchGraphDriveId(accessToken: string): Promise<string> {
  const response = await fetch("https://graph.microsoft.com/v1.0/me/drive", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Graph drive lookup failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!isGraphDriveResponse(data)) {
    throw new Error("Invalid Graph drive response shape");
  }

  return data.id;
}

export async function registerGraphSubscription(
  accessToken: string,
  userId: string,
): Promise<boolean> {
  const notificationUrl = process.env["GRAPH_NOTIFICATION_URL"]?.trim();
  if (!notificationUrl) {
    console.warn(
      "[onedrive-lifecycle] GRAPH_NOTIFICATION_URL not configured, skipping subscription",
    );
    return false;
  }

  const lifecycleNotificationUrl = process.env["GRAPH_LIFECYCLE_URL"]?.trim();
  let driveId: string;
  try {
    driveId = await fetchGraphDriveId(accessToken);
  } catch (error) {
    console.warn("[onedrive-lifecycle] Graph drive lookup failed", error);
    return false;
  }

  const graphSubscriptionMaxMinutes = 4230;
  const expirationDateTime = new Date(
    Date.now() + graphSubscriptionMaxMinutes * 60 * 1000,
  ).toISOString();

  const requestBody = {
    changeType: "updated",
    notificationUrl,
    resource: `/drives/${driveId}/root`,
    expirationDateTime,
    clientState: userId,
    ...(lifecycleNotificationUrl ? { lifecycleNotificationUrl } : {}),
  };
  console.info("[onedrive-lifecycle] Registering Graph subscription", {
    notificationUrl,
    resource: requestBody.resource,
    expirationDateTime,
    lifecycleNotificationUrl: lifecycleNotificationUrl ?? null,
  });

  const response = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const text = await response.text();
    console.warn(
      `[onedrive-lifecycle] Graph subscription registration failed: ${response.status} ${response.statusText}`,
      text,
    );
    return false;
  }
  console.info("[onedrive-lifecycle] Graph subscription created", {
    status: response.status,
  });
  return true;
}

async function handleReauthorizationRequired(notification: LifecycleNotification): Promise<void> {
  if (!notification.subscriptionId) {
    throw new Error("Lifecycle notification missing subscriptionId");
  }

  // Forced: Graph asked for the subscription to be reauthorized, so the stored
  // access token is obsolete even when its clock has not run out yet.
  const grant = await createConnectionTokenResolver().resolveAccessToken(
    notification.clientState,
    ONEDRIVE_PROVIDER,
    { force: true },
  );
  if (grant.kind !== "success") {
    throw new Error(`OneDrive grant for user ${notification.clientState} cannot be refreshed`);
  }
  const accessToken = grant.accessToken;

  try {
    await reauthorizeGraphSubscription(notification.subscriptionId, accessToken);
  } catch (error) {
    console.warn(
      "[onedrive-lifecycle] Graph subscription reauthorize failed; falling back to delete + recreate",
      error,
    );
    await deleteGraphSubscription(notification.subscriptionId, accessToken);
    const recreated = await registerGraphSubscription(accessToken, notification.clientState);
    if (!recreated) {
      throw new Error("Graph subscription recreate failed after reauthorize failure");
    }
  }
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

export const postOnedriveLifecycleEndpoint = defineEndpoint(
  postOnedriveLifecycle,
  async (_input, c: AppContext) => {
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
  },
);

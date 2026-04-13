import { PutParameterCommand } from "@aws-sdk/client-ssm";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { docClient } from "./db.js";
import { resolveOneDriveAccessToken } from "./onedrive-middleware.js";
import { ssmClient } from "./ssm.js";

function usersTable(): string {
  return process.env["USERS_TABLE"] ?? "petroglyph-users-default";
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

interface GraphSubscriptionResponse {
  expirationDateTime: string;
}

const SSM_SUBSCRIPTION_EXPIRY = "/petroglyph/onedrive/subscription-expiry";

function parseGraphSubscriptionResponse(value: unknown): GraphSubscriptionResponse {
  if (!isRecord(value) || typeof value["expirationDateTime"] !== "string") {
    throw new Error("Invalid Graph subscription response shape");
  }

  return { expirationDateTime: value["expirationDateTime"] };
}

async function renewGraphSubscription(
  subscriptionId: string,
  accessToken: string,
): Promise<string> {
  const expirationDateTime = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const response = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expirationDateTime }),
  });

  if (!response.ok) {
    throw new Error(`Graph subscription renewal failed: ${response.status} ${response.statusText}`);
  }

  const data = parseGraphSubscriptionResponse(await response.json());
  return data.expirationDateTime;
}

async function storeSubscriptionExpiry(expirationDateTime: string): Promise<void> {
  await ssmClient.send(
    new PutParameterCommand({
      Name: SSM_SUBSCRIPTION_EXPIRY,
      Value: expirationDateTime,
      Type: "SecureString",
      Overwrite: true,
    }),
  );
}

async function handleReauthorizationRequired(notification: LifecycleNotification): Promise<void> {
  if (!notification.subscriptionId) {
    throw new Error("Lifecycle notification missing subscriptionId");
  }

  const accessToken = await resolveOneDriveAccessToken();
  const subscriptionExpiry = await renewGraphSubscription(notification.subscriptionId, accessToken);
  await storeSubscriptionExpiry(subscriptionExpiry);
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

function dispatchLifecycleNotifications(notifications: LifecycleNotification[]): void {
  queueMicrotask(() => {
    void processLifecycleNotifications(notifications).catch((error: unknown) => {
      console.error("[onedrive-lifecycle] lifecycle processing failed:", error);
    });
  });
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
  dispatchLifecycleNotifications(notifications);

  return c.body(null, 202);
}

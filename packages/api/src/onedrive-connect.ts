import { is, isObject } from "@jaybeeuu/is";
import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import type { AppVariables } from "./auth-middleware.js";
import { docClient } from "./db.js";

function refreshTokensTable(): string {
  return process.env["REFRESH_TOKENS_TABLE"] ?? "petroglyph-refresh_tokens-default";
}

function syncProfilesTable(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

interface ConnectRequestBody {
  code: string;
  state: string;
}

interface OnedriveStateItem {
  tokenHash: string;
  type: string;
  verifier: string;
  ttl: number;
}

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface GraphDriveResponse {
  id: string;
}

class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

function parseConnectBody(body: unknown): ConnectRequestBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as { [key: string]: unknown };
  if (typeof b["code"] !== "string" || b["code"].length === 0) return null;
  if (typeof b["state"] !== "string" || b["state"].length === 0) return null;
  return { code: b["code"], state: b["state"] };
}

const isOnedriveStateItem = isObject<OnedriveStateItem>({
  tokenHash: is("string"),
  type: is("string"),
  verifier: is("string"),
  ttl: is("number"),
});

const isMicrosoftTokenResponse = isObject<MicrosoftTokenResponse>({
  access_token: is("string"),
  refresh_token: is("string"),
  expires_in: is("number"),
});

const isGraphDriveResponse = isObject<GraphDriveResponse>({
  id: is("string"),
});

function parseMicrosoftTokenResponse(data: unknown): MicrosoftTokenResponse {
  if (!isMicrosoftTokenResponse(data)) {
    throw new UpstreamError("Invalid Microsoft token response shape");
  }
  return data;
}

async function lookupStateItem(state: string): Promise<OnedriveStateItem | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: refreshTokensTable(),
      Key: { tokenHash: state },
    }),
  );
  return isOnedriveStateItem(result.Item) ? result.Item : null;
}

async function deleteStateItem(state: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: refreshTokensTable(),
      Key: { tokenHash: state },
    }),
  );
}

async function exchangeCodeForTokens(
  code: string,
  verifier: string,
): Promise<MicrosoftTokenResponse> {
  const clientId = process.env["MICROSOFT_CLIENT_ID"];
  if (!clientId) throw new Error("MICROSOFT_CLIENT_ID env var not set");

  const clientSecret = process.env["MICROSOFT_CLIENT_SECRET"];
  if (!clientSecret) throw new Error("MICROSOFT_CLIENT_SECRET env var not set");

  const redirectUri = process.env["MICROSOFT_REDIRECT_URI"];
  if (!redirectUri) throw new Error("MICROSOFT_REDIRECT_URI env var not set");

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: "files.readwrite offline_access",
  });

  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new UpstreamError(
      `Microsoft token exchange failed: ${response.status} ${response.statusText}`,
    );
  }

  return parseMicrosoftTokenResponse(await response.json());
}

async function fetchGraphDriveId(accessToken: string): Promise<string> {
  const response = await fetch("https://graph.microsoft.com/v1.0/me/drive", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new UpstreamError(`Graph drive lookup failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!isGraphDriveResponse(data)) {
    throw new UpstreamError("Invalid Graph drive response shape");
  }

  return data.id;
}

async function storeTokensInDynamoDB(
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
        "SET accessToken = :accessToken, refreshToken = :refreshToken, expirySeconds = :expirySeconds, updatedAt = :now",
      ExpressionAttributeValues: {
        ":accessToken": accessToken,
        ":refreshToken": refreshToken,
        ":expirySeconds": expirySeconds,
        ":now": new Date().toISOString(),
      },
    }),
  );
}

async function registerGraphSubscription(accessToken: string, userId: string): Promise<void> {
  const notificationUrl = process.env["GRAPH_NOTIFICATION_URL"]?.trim();
  if (!notificationUrl) {
    console.warn("[onedrive-connect] GRAPH_NOTIFICATION_URL not configured, skipping subscription");
    return;
  }

  const lifecycleNotificationUrl = process.env["GRAPH_LIFECYCLE_URL"]?.trim();
  let driveId: string;
  try {
    driveId = await fetchGraphDriveId(accessToken);
  } catch (error) {
    console.warn("[onedrive-connect] Graph drive lookup failed", error);
    return;
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
  console.info("[onedrive-connect] Registering Graph subscription", {
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
      `[onedrive-connect] Graph subscription registration failed: ${response.status} ${response.statusText}`,
      text,
    );
    return;
  }
  console.info("[onedrive-connect] Graph subscription created", {
    status: response.status,
  });
}

async function upsertSyncProfile(userId: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: syncProfilesTable(),
      Key: { userId, profileId: "default" },
      UpdateExpression:
        "SET createdAt = if_not_exists(createdAt, :now), updatedAt = :now, oneDriveConnected = :true",
      ExpressionAttributeValues: {
        ":now": new Date().toISOString(),
        ":true": true,
      },
    }),
  );
}

export function handleOnedriveCallbackBridge(c: Context<{ Variables: AppVariables }>): Response {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || code.length === 0) {
    return c.json({ error: "Missing required query param: code" }, 400);
  }

  if (!state || state.length === 0) {
    return c.json({ error: "Missing required query param: state" }, 400);
  }

  const redirectUrl = new URL("obsidian://petroglyph/oauth/callback");
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", state);

  return c.redirect(redirectUrl.toString(), 302);
}

export async function handleOnedriveConnect(
  c: Context<{ Variables: AppVariables }>,
): Promise<Response> {
  const rawBody: unknown = await c.req.json();
  const body = parseConnectBody(rawBody);

  if (!body) {
    console.warn("[onedrive-connect] Missing code/state in request body");
    return c.json({ error: "Missing required fields: code and state" }, 400);
  }

  const { code, state } = body;
  const userId = c.get("userId");
  console.info("[onedrive-connect] Starting connect flow", { userId });

  const stateItem = await lookupStateItem(state);
  const now = Math.floor(Date.now() / 1000);

  if (!stateItem || stateItem.type !== "onedrive_state" || stateItem.ttl < now) {
    console.warn("[onedrive-connect] Invalid or expired state", {
      userId,
      stateType: stateItem?.type ?? null,
      stateExpiry: stateItem?.ttl ?? null,
      now,
    });
    return c.json({ error: "Invalid or expired state" }, 401);
  }

  await deleteStateItem(state);

  let tokens: MicrosoftTokenResponse;
  try {
    tokens = await exchangeCodeForTokens(code, stateItem.verifier);
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.warn("[onedrive-connect] Microsoft token exchange failed", {
        userId,
        message: err.message,
      });
      return c.json({ error: "Microsoft token exchange failed" }, 502);
    }
    throw err;
  }

  console.info("[onedrive-connect] Microsoft token exchange succeeded", { userId });
  await storeTokensInDynamoDB(userId, tokens.access_token, tokens.refresh_token, tokens.expires_in);
  console.info("[onedrive-connect] Stored Microsoft tokens in DynamoDB", { userId });
  await registerGraphSubscription(tokens.access_token, userId);
  await upsertSyncProfile(userId);
  console.info("[onedrive-connect] OneDrive profile updated", { userId });

  return c.json({ status: "connected" });
}

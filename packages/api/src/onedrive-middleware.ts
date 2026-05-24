import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "./auth-middleware.js";
import { docClient } from "./db.js";

export const TEN_MINUTES_MS = 10 * 60 * 1000;

function refreshTokensTable(): string {
  return process.env["REFRESH_TOKENS_TABLE"] ?? "petroglyph-refresh_tokens-default";
}

export interface OneDriveParams {
  accessToken: string;
  tokenExpirySeconds: number;
  refreshToken: string;
}

function parseOneDriveParams(value: unknown, userId: string): OneDriveParams {
  if (typeof value !== "object" || value === null) {
    throw new Error(`OneDrive token record missing for user ${userId}`);
  }
  const item = value as { [key: string]: unknown };
  if (typeof item["accessToken"] !== "string" || item["accessToken"].length === 0) {
    throw new Error(`OneDrive accessToken missing for user ${userId}`);
  }
  if (typeof item["refreshToken"] !== "string" || item["refreshToken"].length === 0) {
    throw new Error(`OneDrive refreshToken missing for user ${userId}`);
  }
  if (typeof item["expirySeconds"] !== "number") {
    throw new Error(`OneDrive expirySeconds missing for user ${userId}`);
  }

  return {
    accessToken: item["accessToken"],
    refreshToken: item["refreshToken"],
    tokenExpirySeconds: item["expirySeconds"],
  };
}

export async function readOneDriveParams(userId: string): Promise<OneDriveParams> {
  const result = await docClient.send(
    new GetCommand({
      TableName: refreshTokensTable(),
      Key: { tokenHash: userId },
    }),
  );

  return parseOneDriveParams(result.Item, userId);
}

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function assertMicrosoftTokenResponse(value: unknown): asserts value is MicrosoftTokenResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Microsoft token response is not an object");
  }
  const obj = value as { [key: string]: unknown };
  if (typeof obj["access_token"] !== "string") {
    throw new Error("Microsoft token response missing string access_token");
  }
  if (typeof obj["refresh_token"] !== "string") {
    throw new Error("Microsoft token response missing string refresh_token");
  }
  if (typeof obj["expires_in"] !== "number") {
    throw new Error("Microsoft token response missing number expires_in");
  }
}

export async function refreshOneDriveToken(
  currentRefreshToken: string,
): Promise<MicrosoftTokenResponse> {
  const clientId = process.env["MICROSOFT_CLIENT_ID"];
  if (!clientId) throw new Error("MICROSOFT_CLIENT_ID env var not set");
  const clientSecret = process.env["MICROSOFT_CLIENT_SECRET"];
  if (!clientSecret) throw new Error("MICROSOFT_CLIENT_SECRET env var not set");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken,
    scope: "files.read offline_access",
  });

  const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Microsoft token refresh failed with status ${response.status}`);
  }

  const data: unknown = await response.json();
  assertMicrosoftTokenResponse(data);

  return data;
}

async function storeOneDriveParams(
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

export async function resolveOneDriveAccessToken(userId: string): Promise<string> {
  const params = await readOneDriveParams(userId);
  const msUntilExpiry = params.tokenExpirySeconds * 1000 - Date.now();

  if (msUntilExpiry <= TEN_MINUTES_MS) {
    try {
      const refreshed = await refreshOneDriveToken(params.refreshToken);
      await storeOneDriveParams(
        userId,
        refreshed.access_token,
        refreshed.refresh_token,
        refreshed.expires_in,
      );
      return refreshed.access_token;
    } catch (err) {
      console.error("[onedrive-middleware] token refresh failed:", err);
    }
  }

  return params.accessToken;
}

export const onedriveMiddleware: MiddlewareHandler<{
  Variables: AppVariables;
}> = async (c, next) => {
  let accessToken: string | undefined;
  const userId = c.get("userId");

  if (!userId) {
    console.error("[onedrive-middleware] missing userId in request context");
  } else {
    try {
      accessToken = await resolveOneDriveAccessToken(userId);
    } catch (err) {
      console.error("[onedrive-middleware] DynamoDB read failed:", err);
    }
  }

  c.set("onedriveAccessToken", accessToken);
  await next();
};

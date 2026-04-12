import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "./auth-middleware.js";
import { ssmClient } from "./ssm.js";

export const TEN_MINUTES_MS = 10 * 60 * 1000;

const SSM_ACCESS_TOKEN = "/petroglyph/onedrive/access-token";
const SSM_TOKEN_EXPIRY = "/petroglyph/onedrive/token-expiry";
const SSM_REFRESH_TOKEN = "/petroglyph/onedrive/refresh-token";

async function readSsmString(name: string): Promise<string> {
  const result = await ssmClient.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter not found or empty: ${name}`);
  return value;
}

export interface OneDriveParams {
  accessToken: string;
  tokenExpiry: string;
  refreshToken: string;
}

export async function readOneDriveParams(): Promise<OneDriveParams> {
  const [accessToken, tokenExpiry, refreshToken] = await Promise.all([
    readSsmString(SSM_ACCESS_TOKEN),
    readSsmString(SSM_TOKEN_EXPIRY),
    readSsmString(SSM_REFRESH_TOKEN),
  ]);
  return { accessToken, tokenExpiry, refreshToken };
}

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function assertMicrosoftTokenResponse(
  value: unknown,
): asserts value is MicrosoftTokenResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Microsoft token response is not an object");
  }
  const obj = value as Record<string, unknown>;
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
): Promise<string> {
  const clientId = process.env["MICROSOFT_CLIENT_ID"];
  if (!clientId) throw new Error("MICROSOFT_CLIENT_ID env var not set");

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken,
    scope: "files.read offline_access",
  });

  const response = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Microsoft token refresh failed with status ${response.status}`,
    );
  }

  const data: unknown = await response.json();
  assertMicrosoftTokenResponse(data);

  const { access_token, refresh_token, expires_in } = data;
  const newExpiry = new Date(Date.now() + expires_in * 1000).toISOString();

  await Promise.all([
    ssmClient.send(
      new PutParameterCommand({
        Name: SSM_ACCESS_TOKEN,
        Value: access_token,
        Overwrite: true,
      }),
    ),
    ssmClient.send(
      new PutParameterCommand({
        Name: SSM_TOKEN_EXPIRY,
        Value: newExpiry,
        Overwrite: true,
      }),
    ),
    ssmClient.send(
      new PutParameterCommand({
        Name: SSM_REFRESH_TOKEN,
        Value: refresh_token,
        Overwrite: true,
      }),
    ),
  ]);

  return access_token;
}

export async function resolveOneDriveAccessToken(): Promise<string> {
  const params = await readOneDriveParams();
  const msUntilExpiry = new Date(params.tokenExpiry).getTime() - Date.now();

  if (msUntilExpiry <= TEN_MINUTES_MS) {
    try {
      return await refreshOneDriveToken(params.refreshToken);
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

  try {
    accessToken = await resolveOneDriveAccessToken();
  } catch (err) {
    console.error("[onedrive-middleware] SSM read failed:", err);
  }

  c.set("onedriveAccessToken", accessToken);
  await next();
};

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { AppVariables } from "./auth-middleware.js";
import { docClient } from "./db.js";

const TABLE_NAME =
  process.env["REFRESH_TOKENS_TABLE"] ?? "petroglyph-refresh_tokens-default";

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function handleOnedriveAuthUrl(
  c: Context<{ Variables: AppVariables }>,
): Promise<Response> {
  const clientId = process.env["MICROSOFT_CLIENT_ID"];
  const redirectUri = process.env["MICROSOFT_REDIRECT_URI"];

  if (!clientId || !redirectUri) {
    return c.json({ error: "Missing OAuth configuration" }, 500);
  }

  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = randomUUID();
  const ttl = Math.floor(Date.now() / 1000) + 600;

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { token: state, type: "onedrive_state", verifier, ttl },
    }),
  );

  const url = new URL(
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  );
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "files.read offline_access");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return c.json({ url: url.toString() });
}

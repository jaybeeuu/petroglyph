import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { SignJWT, importPKCS8 } from "jose";
import { createHash, randomUUID } from "node:crypto";
import { docClient } from "./db.js";

function refreshTokensTable(): string {
  return (
    process.env["REFRESH_TOKENS_TABLE"] ?? "petroglyph-refresh_tokens-default"
  );
}

function usersTable(): string {
  return process.env["USERS_TABLE"] ?? "petroglyph-users-default";
}

interface StateItem {
  token: string;
  type: string;
  ttl: number;
}

interface GitHubTokenResponse {
  access_token: string;
}

interface GitHubUser {
  id: number;
  login: string;
}

interface CallbackRequestBody {
  code: string;
  state: string;
}

async function lookUpState(state: string): Promise<StateItem | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: refreshTokensTable(),
      Key: { token: state },
    }),
  );
  return result.Item as StateItem | undefined;
}

async function deleteState(state: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: refreshTokensTable(),
      Key: { token: state },
    }),
  );
}

async function exchangeCodeForToken(code: string): Promise<string> {
  const clientId = process.env["GITHUB_CLIENT_ID"];
  const clientSecret = process.env["GITHUB_CLIENT_SECRET"];

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  const data = (await response.json()) as GitHubTokenResponse;
  return data.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  return (await response.json()) as GitHubUser;
}

async function upsertUser(userId: string, username: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: usersTable(),
      Key: { userId },
      UpdateExpression:
        "SET username = :username, createdAt = if_not_exists(createdAt, :now)",
      ExpressionAttributeValues: {
        ":username": username,
        ":now": new Date().toISOString(),
      },
    }),
  );
}

async function issueJwt(userId: string, username: string): Promise<string> {
  const privateKeyPem = process.env["JWT_PRIVATE_KEY"];
  if (!privateKeyPem) {
    throw new Error("JWT_PRIVATE_KEY not configured");
  }

  const privateKey = await importPKCS8(privateKeyPem, "RS256");

  return new SignJWT({ username })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

async function storeRefreshToken(
  refreshToken: string,
  userId: string,
): Promise<void> {
  const hash = createHash("sha256").update(refreshToken).digest("hex");
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

  await docClient.send(
    new PutCommand({
      TableName: refreshTokensTable(),
      Item: {
        token: hash,
        type: "refresh_token",
        userId,
        ttl,
      },
    }),
  );
}

export async function handleAuthCallback(c: Context): Promise<Response> {
  const body = await c.req.json<CallbackRequestBody>();
  const { code, state } = body;

  const stateItem = await lookUpState(state);
  const now = Math.floor(Date.now() / 1000);

  if (!stateItem || stateItem.type !== "oauth_state" || stateItem.ttl < now) {
    return c.json({ error: "Invalid or expired state" }, 401);
  }

  await deleteState(state);

  const accessToken = await exchangeCodeForToken(code);
  const githubUser = await fetchGitHubUser(accessToken);

  const userId = String(githubUser.id);
  const { login: username } = githubUser;

  await upsertUser(userId, username);

  const jwt = await issueJwt(userId, username);

  const refreshToken = randomUUID();
  await storeRefreshToken(refreshToken, userId);

  return c.json({ jwt, refreshToken, username });
}

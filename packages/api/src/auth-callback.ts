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

class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringProp<K extends string>(
  value: Record<string, unknown>,
  key: K,
): value is Record<string, unknown> & Record<K, string> {
  return typeof value[key] === "string";
}

function hasNumberProp<K extends string>(
  value: Record<string, unknown>,
  key: K,
): value is Record<string, unknown> & Record<K, number> {
  return typeof value[key] === "number";
}

function parseGitHubTokenResponse(data: unknown): GitHubTokenResponse {
  if (!isRecord(data) || !hasStringProp(data, "access_token")) {
    throw new UpstreamError("Invalid GitHub token response shape");
  }
  return { access_token: data.access_token };
}

function parseGitHubUser(data: unknown): GitHubUser {
  if (
    !isRecord(data) ||
    !hasNumberProp(data, "id") ||
    !hasStringProp(data, "login")
  ) {
    throw new UpstreamError("Invalid GitHub user response shape");
  }
  return { id: data.id, login: data.login };
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
  if (!clientId) {
    throw new Error("GITHUB_CLIENT_ID not configured");
  }
  const clientSecret = process.env["GITHUB_CLIENT_SECRET"];
  if (!clientSecret) {
    throw new Error("GITHUB_CLIENT_SECRET not configured");
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  if (!response.ok) {
    throw new UpstreamError(
      `GitHub token exchange failed: ${response.status} ${response.statusText}`,
    );
  }

  return parseGitHubTokenResponse(await response.json()).access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!response.ok) {
    throw new UpstreamError(
      `GitHub user fetch failed: ${response.status} ${response.statusText}`,
    );
  }

  return parseGitHubUser(await response.json());
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
    .setIssuer("petroglyph-api")
    .setAudience("petroglyph-plugin")
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

  let accessToken: string;
  let githubUser: GitHubUser;
  try {
    accessToken = await exchangeCodeForToken(code);
    githubUser = await fetchGitHubUser(accessToken);
  } catch (err) {
    if (err instanceof UpstreamError) {
      return c.json({ error: "GitHub API error" }, 502);
    }
    throw err;
  }

  const userId = String(githubUser.id);
  const { login: username } = githubUser;

  await upsertUser(userId, username);

  const jwt = await issueJwt(userId, username);

  const refreshToken = randomUUID();
  await storeRefreshToken(refreshToken, userId);

  return c.json({ jwt, refreshToken, username });
}

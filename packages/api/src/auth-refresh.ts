import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
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

interface RefreshTokenItem {
  token: string;
  type: string;
  userId: string;
  ttl: number;
  superseded?: boolean;
}

interface UserItem {
  userId: string;
  username: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRefreshTokenItem(value: unknown): value is RefreshTokenItem {
  return (
    isRecord(value) &&
    typeof value["token"] === "string" &&
    typeof value["type"] === "string" &&
    typeof value["userId"] === "string" &&
    typeof value["ttl"] === "number"
  );
}

function isUserItem(value: unknown): value is UserItem {
  return (
    isRecord(value) &&
    typeof value["userId"] === "string" &&
    typeof value["username"] === "string"
  );
}

async function lookupRefreshToken(
  hash: string,
): Promise<RefreshTokenItem | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: refreshTokensTable(),
      Key: { token: hash },
    }),
  );
  const item = result.Item;
  return isRefreshTokenItem(item) ? item : undefined;
}

async function atomicMarkTokenSuperseded(hash: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: refreshTokensTable(),
      Key: { token: hash },
      UpdateExpression: "SET superseded = :true",
      ConditionExpression:
        "superseded = :false OR attribute_not_exists(superseded)",
      ExpressionAttributeValues: { ":true": true, ":false": false },
    }),
  );
}

async function deleteAllUserTokens(userId: string): Promise<void> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: refreshTokensTable(),
        FilterExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
        ...(exclusiveStartKey !== undefined && {
          ExclusiveStartKey: exclusiveStartKey,
        }),
      }),
    );
    const items = result.Items ?? [];
    await Promise.all(
      items.map((item) => {
        if (typeof item["token"] !== "string") return Promise.resolve();
        return docClient.send(
          new DeleteCommand({
            TableName: refreshTokensTable(),
            Key: { token: item["token"] },
          }),
        );
      }),
    );
    exclusiveStartKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (exclusiveStartKey !== undefined);
}

async function fetchUser(userId: string): Promise<UserItem | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: usersTable(),
      Key: { userId },
    }),
  );
  const item = result.Item;
  return isUserItem(item) ? item : undefined;
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

async function storeNewRefreshToken(
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
        superseded: false,
      },
    }),
  );
}

export async function handleAuthRefresh(c: Context): Promise<Response> {
  const body: unknown = await c.req.json();
  const refreshToken = isRecord(body) ? body["refreshToken"] : undefined;

  if (typeof refreshToken !== "string") {
    return c.json({ error: "Missing refreshToken" }, 400);
  }

  const hash = createHash("sha256").update(refreshToken).digest("hex");
  const tokenItem = await lookupRefreshToken(hash);
  const now = Math.floor(Date.now() / 1000);

  if (!tokenItem) {
    return c.json({ error: "Invalid refresh token" }, 401);
  }

  if (tokenItem.type !== "refresh_token") {
    return c.json({ error: "Invalid refresh token" }, 401);
  }

  if (tokenItem.ttl < now) {
    return c.json({ error: "Refresh token expired" }, 401);
  }

  try {
    await atomicMarkTokenSuperseded(hash);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      console.warn(
        "[security] Token reuse detected for userId:",
        tokenItem.userId,
      );
      await deleteAllUserTokens(tokenItem.userId);
      return c.json({ error: "Token reuse detected" }, 401);
    }
    throw err;
  }

  const user = await fetchUser(tokenItem.userId);
  const username = user?.username ?? tokenItem.userId;

  const jwt = await issueJwt(tokenItem.userId, username);

  const newRefreshToken = randomUUID();
  await storeNewRefreshToken(newRefreshToken, tokenItem.userId);

  return c.json({ jwt, refreshToken: newRefreshToken });
}

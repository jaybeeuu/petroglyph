import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { docClient } from "./db.js";

const TABLE_NAME =
  process.env["REFRESH_TOKENS_TABLE"] ?? "petroglyph-refresh_tokens-default";

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

app.get("/auth/url", async (c) => {
  const clientId = process.env["GITHUB_CLIENT_ID"];
  const redirectUri = process.env["GITHUB_REDIRECT_URI"];
  if (!clientId || !redirectUri) {
    return c.json({ error: "Missing OAuth configuration" }, 500);
  }

  const state = randomUUID();
  const ttl = Math.floor(Date.now() / 1000) + 600;

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { token: state, type: "oauth_state", ttl },
    }),
  );

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);

  return c.json({ url: url.toString() });
});

export { app };

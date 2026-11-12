import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { defineEndpoint } from "@petroglyph/contracts/hono";
import { getAuthUrl } from "@petroglyph/contracts/operations";
import { randomUUID } from "node:crypto";
import type { AppContext } from "./auth-middleware.js";
import { docClient } from "./db.js";

const TABLE_NAME = process.env["REFRESH_TOKENS_TABLE"] ?? "petroglyph-refresh_tokens-default";

export const getAuthUrlEndpoint = defineEndpoint(getAuthUrl, async (_input, c: AppContext) => {
  const clientId = process.env["GITHUB_CLIENT_ID"];
  const redirectUri = process.env["GITHUB_REDIRECT_URI"];
  const returnUri = c.req.query("returnUri");

  if (!clientId || !redirectUri) {
    return c.json({ error: "Missing OAuth configuration" }, 500);
  }

  if (typeof returnUri !== "string" || returnUri.length === 0) {
    return c.json({ error: "returnUri is required" }, 400);
  }

  const state = randomUUID();
  const ttl = Math.floor(Date.now() / 1000) + 600;
  await docClient().send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { tokenHash: state, type: "oauth_state", ttl, returnUri },
    }),
  );

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);

  return c.json({ url: url.toString() });
});

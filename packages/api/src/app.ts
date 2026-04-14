import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { handleAuthCallback } from "./auth-callback.js";
import { handleAuthRefresh } from "./auth-refresh.js";
import { authMiddleware, type AppVariables } from "./auth-middleware.js";
import { onedriveMiddleware } from "./onedrive-middleware.js";
import { handleOnedriveAuthUrl } from "./onedrive-auth-url.js";
import { handleOnedriveConnect } from "./onedrive-connect.js";
import { handleOnedriveLifecycle } from "./onedrive-lifecycle.js";
import { handleFilesChanges } from "./files-changes.js";
import { handleListProfiles, handleCreateProfile } from "./profiles.js";
import { handleGetProfile, handlePutProfile, handleDeleteProfile } from "./profiles-crud.js";
import { handleStatus } from "./status.js";
import { handleSyncRun } from "./sync-run.js";
import { handleSyncReset } from "./sync-reset.js";
import { docClient } from "./db.js";

const TABLE_NAME = process.env["REFRESH_TOKENS_TABLE"] ?? "petroglyph-refresh_tokens-default";

const EXEMPT_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/auth/url" },
  { method: "POST", path: "/auth/callback" },
  { method: "POST", path: "/auth/refresh" },
  { method: "POST", path: "/onedrive/lifecycle" },
];

const app = new Hono<{ Variables: AppVariables }>();

app.use("*", (c, next) => {
  const isExempt = EXEMPT_ROUTES.some(
    (route) => route.method === c.req.method && route.path === c.req.path,
  );
  if (isExempt) return next();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return authMiddleware(c as unknown as Context<{ Variables: AppVariables }>, next);
});

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

app.post("/auth/callback", (c) => handleAuthCallback(c));

app.post("/auth/refresh", (c) => handleAuthRefresh(c));

app.get("/status", (c) => handleStatus(c));

app.get("/files/changes", (c) => handleFilesChanges(c));

app.get("/profiles", (c) => handleListProfiles(c));
app.post("/profiles", (c) => handleCreateProfile(c));
app.get("/profiles/:id", (c) => handleGetProfile(c));
app.put("/profiles/:id", (c) => handlePutProfile(c));
app.delete("/profiles/:id", (c) => handleDeleteProfile(c));

app.get("/onedrive/auth-url", (c) => handleOnedriveAuthUrl(c));

app.post("/onedrive/connect", (c) => handleOnedriveConnect(c));

app.post("/onedrive/lifecycle", (c) => handleOnedriveLifecycle(c));

app.post("/sync/reset", (c) => handleSyncReset(c));

app.post("/sync/run", (c) => handleSyncRun(c));

app.use("/onedrive/*", (c, next) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  onedriveMiddleware(c as unknown as Context<{ Variables: AppVariables }>, next),
);

export { app };

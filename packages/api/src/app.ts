import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware, type AppVariables } from "./auth-middleware.js";
import { onedriveMiddleware } from "./onedrive-middleware.js";
import { createHandlers, registerRoutes } from "./routes.js";
import { createSyncTriggerDeps, type SyncTriggerDeps } from "./sync-trigger.js";

const EXEMPT_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/auth/url" },
  { method: "GET", path: "/auth/callback" },
  { method: "POST", path: "/auth/refresh" },
  { method: "POST", path: "/onedrive/lifecycle" },
  { method: "GET", path: "/onedrive/connect" },
];

/**
 * Builds the route graph. Sync Now's collaborators are a parameter so a test
 * can drive the real route with its own vault reads and its own queue; the
 * default wires the deployed ones, built on first construction rather than at
 * module scope.
 *
 * Routes come from the operation registry through `registerRoutes`, so the
 * served surface and the contract cannot drift apart here.
 */
export function createApp(
  syncTriggerDeps: SyncTriggerDeps = createSyncTriggerDeps(),
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use(
    "*",
    cors({
      origin: ["app://obsidian.md", "capacitor://localhost", "http://localhost"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
    }),
  );

  app.use("*", (c, next) => {
    const isExempt = EXEMPT_ROUTES.some(
      (route) => route.method === c.req.method && route.path === c.req.path,
    );
    if (isExempt) return next();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return authMiddleware(c as unknown as Context<{ Variables: AppVariables }>, next);
  });

  registerRoutes(app, createHandlers(syncTriggerDeps));

  app.use("/onedrive/*", (c, next) =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    onedriveMiddleware(c as unknown as Context<{ Variables: AppVariables }>, next),
  );

  return app;
}

import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware, type AppVariables } from "./auth-middleware.js";
import { onedriveMiddleware } from "./onedrive-middleware.js";
import { createDeployedProfilePathReset } from "./profile-path-reset.js";
import { createHandlers, registerRoutes, type AppDeps } from "./routes.js";
import { createSyncTriggerDeps } from "./sync-trigger.js";

const EXEMPT_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/auth/url" },
  { method: "GET", path: "/auth/callback" },
  { method: "POST", path: "/auth/refresh" },
  { method: "POST", path: "/onedrive/lifecycle" },
  { method: "GET", path: "/onedrive/connect" },
];

/**
 * The deployed collaborators. Both resolve their clients and configuration per
 * use, so building the app is cheap and reads no environment.
 */
export function createAppDeps(): AppDeps {
  return {
    syncTrigger: createSyncTriggerDeps(),
    profilePathReset: createDeployedProfilePathReset(),
  };
}

/**
 * Builds the route graph. Sync Now's collaborators and the profile path reset
 * are parameters, so a test can drive the real routes with its own vault,
 * queue, bucket and table; the default wires the deployed ones, built on first
 * construction rather than at module scope.
 *
 * Routes come from the operation registry through `registerRoutes`, so the
 * served surface and the contract cannot drift apart here.
 */
export function createApp(deps: AppDeps = createAppDeps()): Hono<{ Variables: AppVariables }> {
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

  registerRoutes(app, createHandlers(deps));

  app.use("/onedrive/*", (c, next) =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    onedriveMiddleware(c as unknown as Context<{ Variables: AppVariables }>, next),
  );

  return app;
}

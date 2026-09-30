import type { MiddlewareHandler } from "hono";
import { verifyJwt } from "./jwt.js";
import type { FilesRouterVariables } from "./app.js";

/**
 * Layer-1 identity (user ↔ Petroglyph), deferred as-is per decisions §9:
 * GitHub JWT today, shared with the api surface. Only the userId claim is
 * consumed — everything downstream scopes on it.
 */
export const authMiddleware: MiddlewareHandler<{
  Variables: FilesRouterVariables;
}> = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "UNAUTHORIZED" }, 401);
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    const { userId } = await verifyJwt(token);
    c.set("userId", userId);
    await next();
    return;
  } catch {
    return c.json({ error: "UNAUTHORIZED" }, 401);
  }
};

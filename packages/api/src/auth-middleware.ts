import type { MiddlewareHandler } from "hono";
import { verifyJwt } from "./jwt.js";

export interface AppVariables {
  userId: string;
  username: string;
  onedriveAccessToken: string | undefined;
}

export const authMiddleware: MiddlewareHandler<{
  Variables: AppVariables;
}> = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "UNAUTHORIZED" }, 401);
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    const { userId, username } = await verifyJwt(token);
    c.set("userId", userId);
    c.set("username", username);
    await next();
    return;
  } catch {
    return c.json({ error: "UNAUTHORIZED" }, 401);
  }
};

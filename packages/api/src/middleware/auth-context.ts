import type { Context, MiddlewareHandler } from "hono";
import type { ResolvedAuthContext } from "../auth/context.js";

const AUTH_CONTEXT_KEY = "authContext";

// Sets the resolved auth context into a Hono request context.
export function setAuthContext(c: Context, ctx: ResolvedAuthContext): void {
  c.set(AUTH_CONTEXT_KEY, ctx);
}

// Returns the resolved auth context for the current request.
// Throws if called outside of a protected route (i.e., before the auth middleware chain runs).
export function getAuthContext(c: Context): ResolvedAuthContext {
  const ctx = c.get(AUTH_CONTEXT_KEY) as ResolvedAuthContext | undefined;
  if (!ctx) {
    throw new Error(
      "Auth context is not set. Ensure this handler is used inside a protected route.",
    );
  }
  return ctx;
}

// Type-safe Hono environment variable declaration for the auth context.
export type AuthContextEnv = {
  Variables: {
    [AUTH_CONTEXT_KEY]: ResolvedAuthContext;
  };
};

// Middleware that guards a route and returns 401 if the auth context has not been resolved.
// Use after the authenticate and resolve-identity middleware for double-safety.
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!c.get(AUTH_CONTEXT_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
};

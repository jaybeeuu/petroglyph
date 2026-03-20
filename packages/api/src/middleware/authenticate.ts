import type { MiddlewareHandler } from "hono";
import { isFail } from "@petroglyph/core";
import type { AuthProvider } from "../auth/provider.js";
import { missingToken } from "../auth/errors.js";

// Extracts the bearer token from the Authorization header, validates it via the
// configured AuthProvider, and attaches the parsed claims to the request context.
// Returns 401 for missing, malformed, expired, or otherwise invalid tokens.
export function authenticate(provider: AuthProvider): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      const error = missingToken();
      return c.json({ error: "Unauthorized", reason: error.kind }, 401);
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (token.length === 0) {
      const error = missingToken();
      return c.json({ error: "Unauthorized", reason: error.kind }, 401);
    }

    const result = await provider.validateToken(token);

    if (isFail(result)) {
      const authError = result.failure;
      return c.json({ error: "Unauthorized", reason: authError.kind }, 401);
    }

    c.set("tokenClaims", result.value);
    return next();
  };
}

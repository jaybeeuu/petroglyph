import type { MiddlewareHandler } from "hono";
import type { AccountRepository } from "../account/repository.js";
import { setAuthContext } from "./auth-context.js";
import { unknownIdentity, disabledAccount } from "../auth/errors.js";
import type { EntraTokenClaims } from "../auth/claims.js";

// Maps validated token claims to a known application user.
// Depends on the authenticate middleware having already run and stored `tokenClaims`.
// Returns 401 for unknown identities or disabled accounts.
//
// Per ADR 0011, a valid external identity alone is not enough: it must be linked to a
// known application account, and that account must be active.
export function resolveIdentity(repository: AccountRepository): MiddlewareHandler {
  return async (c, next) => {
    const claims = c.get("tokenClaims") as EntraTokenClaims | undefined;
    if (!claims) {
      return c.json({ error: "Unauthorized", reason: "missing_token" }, 401);
    }

    const identity = await repository.findIdentityByExternalId("entra", claims.oid);
    if (!identity) {
      const error = unknownIdentity();
      return c.json({ error: "Unauthorized", reason: error.kind }, 401);
    }

    const user = await repository.findUserById(identity.userId);
    if (!user) {
      const error = unknownIdentity();
      return c.json({ error: "Unauthorized", reason: error.kind }, 401);
    }

    if (user.status === "disabled") {
      const error = disabledAccount();
      return c.json({ error: "Unauthorized", reason: error.kind }, 401);
    }

    setAuthContext(c, { user });
    return next();
  };
}

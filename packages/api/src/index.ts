// Public exports from packages/api.
// Consumers should import from this entry-point rather than from internal modules.

export type { ResolvedAuthContext } from "./auth/context.js";
export type { AuthProvider } from "./auth/provider.js";
export type { AuthError } from "./auth/errors.js";
export type { EntraTokenClaims } from "./auth/claims.js";
export { EntraTokenClaimsSchema } from "./auth/claims.js";
export {
  missingToken,
  malformedToken,
  expiredToken,
  invalidToken,
  unknownIdentity,
  disabledAccount,
} from "./auth/errors.js";
export { MockAuthProvider } from "./auth/mock-provider.js";
export { EntraAuthProvider } from "./auth/entra-provider.js";
export { createAuthProvider } from "./auth/provider-factory.js";
export type { AccountRepository } from "./account/repository.js";
export { InMemoryAccountRepository } from "./account/in-memory-repository.js";
export { authenticate } from "./middleware/authenticate.js";
export { resolveIdentity } from "./middleware/resolve-identity.js";
export { getAuthContext, setAuthContext, requireAuth } from "./middleware/auth-context.js";
export { loadConfig } from "./config.js";

import type { Result } from "@petroglyph/core";
import type { AuthError } from "./errors.js";
import type { EntraTokenClaims } from "./claims.js";

// The AuthProvider interface abstracts how a bearer token is validated.
// Implementations include the real Entra JWKS-backed provider and a local mock provider.
// Both must satisfy this contract so the middleware remains provider-agnostic.
export interface AuthProvider {
  // Validates a raw bearer token string.
  // Returns the parsed claims on success or a typed AuthError on failure.
  validateToken(token: string): Promise<Result<EntraTokenClaims, AuthError>>;
}

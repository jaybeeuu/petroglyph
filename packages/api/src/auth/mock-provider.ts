import { ok } from "@petroglyph/core";
import type { Result } from "@petroglyph/core";
import type { AuthError } from "./errors.js";
import type { EntraTokenClaims } from "./claims.js";
import type { AuthProvider } from "./provider.js";

// Synthetic identity used when AUTH_MODE=mock.
// The externalId matches the `oid` claim below so identity-resolution fixtures can link against it.
export const MOCK_OID = "mock-oid-00000000-0000-0000-0000-000000000001";
export const MOCK_TID = "mock-tid-00000000-0000-0000-0000-000000000001";
export const MOCK_SUB = "mock-sub-00000000-0000-0000-0000-000000000001";
export const MOCK_AUD = "mock-client-id";
export const MOCK_ISS = "https://mock.auth/issuer";

// MockAuthProvider accepts any non-empty string as a bearer token and returns
// a fixed set of synthetic Entra-style claims. Used for local development and tests
// where real Entra credentials are unavailable or undesirable.
export class MockAuthProvider implements AuthProvider {
  async validateToken(token: string): Promise<Result<EntraTokenClaims, AuthError>> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    // The mock accepts any non-empty token and returns synthetic claims.
    // The token value is not inspected; it is used only to satisfy the interface.
    void token;
    return Promise.resolve(
      ok({
        sub: MOCK_SUB,
        oid: MOCK_OID,
        tid: MOCK_TID,
        iss: MOCK_ISS,
        aud: MOCK_AUD,
        exp: nowSeconds + 3600,
        iat: nowSeconds,
        nbf: nowSeconds,
        preferred_username: "mock-user@example.com",
      }),
    );
  }
}

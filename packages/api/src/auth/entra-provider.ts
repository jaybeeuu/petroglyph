import { createRemoteJWKSet, jwtVerify } from "jose";
import { ok, fail } from "@petroglyph/core";
import type { Result } from "@petroglyph/core";
import { EntraTokenClaimsSchema } from "./claims.js";
import {
  malformedToken,
  expiredToken,
  invalidToken,
} from "./errors.js";
import type { AuthError } from "./errors.js";
import type { EntraTokenClaims } from "./claims.js";
import type { AuthProvider } from "./provider.js";

export interface EntraAuthProviderOptions {
  tenantId: string;
  clientId: string;
  // Override the authority base URL; defaults to https://login.microsoftonline.com.
  authority?: string;
}

// Validates Microsoft Entra-issued JWTs by fetching the issuer's public keys via JWKS.
// Checks issuer, audience, expiry, and signature per ADR 0007.
export class EntraAuthProvider implements AuthProvider {
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;
  readonly #expectedAudience: string;
  readonly #expectedIssuer: string;

  constructor(options: EntraAuthProviderOptions) {
    const authority = options.authority ?? "https://login.microsoftonline.com";
    // Entra V2 JWKS endpoint for the tenant.
    const jwksUri = new URL(`${authority}/${options.tenantId}/discovery/v2.0/keys`);
    this.#jwks = createRemoteJWKSet(jwksUri);
    this.#expectedAudience = options.clientId;
    this.#expectedIssuer = `${authority}/${options.tenantId}/v2.0`;
  }

  async validateToken(token: string): Promise<Result<EntraTokenClaims, AuthError>> {
    let payload: unknown;
    try {
      const result = await jwtVerify(token, this.#jwks, {
        audience: this.#expectedAudience,
        issuer: this.#expectedIssuer,
      });
      payload = result.payload;
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("expired")) {
          return fail(expiredToken());
        }
        if (
          error.message.includes("audience") ||
          error.message.includes("issuer") ||
          error.message.includes("signature")
        ) {
          return fail(invalidToken(error.message));
        }
        return fail(malformedToken(error.message));
      }
      return fail(malformedToken("Unknown JWT validation error"));
    }

    const parsed = EntraTokenClaimsSchema.safeParse(payload);
    if (!parsed.success) {
      return fail(
        malformedToken(`Token claims do not match expected shape: ${parsed.error.message}`),
      );
    }

    return ok(parsed.data);
  }
}

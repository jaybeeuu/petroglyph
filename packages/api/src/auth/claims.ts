import { z } from "zod";

// Zod schema for the minimum Entra-issued JWT claim set the API requires.
// Only the claims needed for identity resolution and token validation are declared here.
// Additional application-specific claims may be added as needed.
export const EntraTokenClaimsSchema = z.object({
  // Subject: stable per-user per-app identifier issued by Entra.
  sub: z.string(),
  // Object ID: the Entra user/service-principal object ID. Used as the stable external identity key.
  oid: z.string(),
  // Tenant ID: the Azure AD tenant that issued the token.
  tid: z.string(),
  // Issuer: validated against the expected Entra authority.
  iss: z.string(),
  // Audience: the client/app ID this token was issued for.
  aud: z.string(),
  // Expiry (seconds since epoch).
  exp: z.number(),
  // Issued at (seconds since epoch).
  iat: z.number(),
  // Not before (seconds since epoch).
  nbf: z.number(),
  // Email hint from Entra; optional and may be absent on some token types.
  preferred_username: z.string().optional(),
});

export type EntraTokenClaims = z.infer<typeof EntraTokenClaimsSchema>;

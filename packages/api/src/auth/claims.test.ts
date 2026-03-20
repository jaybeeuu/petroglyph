import { describe, it, expect } from "vitest";
import { EntraTokenClaimsSchema } from "./claims.js";

const validClaims = {
  sub: "sub-abc",
  oid: "oid-abc",
  tid: "tid-abc",
  iss: "https://login.microsoftonline.com/tenant/v2.0",
  aud: "client-id",
  exp: 9999999999,
  iat: 1700000000,
  nbf: 1700000000,
};

describe("EntraTokenClaimsSchema", () => {
  it("parses a minimal valid claim set", () => {
    const result = EntraTokenClaimsSchema.safeParse(validClaims);
    expect(result.success).toBe(true);
  });

  it("parses claims that include preferred_username", () => {
    const result = EntraTokenClaimsSchema.safeParse({
      ...validClaims,
      preferred_username: "user@example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preferred_username).toBe("user@example.com");
    }
  });

  it("treats preferred_username as optional", () => {
    const result = EntraTokenClaimsSchema.safeParse(validClaims);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preferred_username).toBeUndefined();
    }
  });

  it.each([["sub"], ["oid"], ["tid"], ["iss"], ["aud"], ["exp"], ["iat"], ["nbf"]])(
    "rejects claims missing required field '%s'",
    (field) => {
      const { [field as keyof typeof validClaims]: _, ...rest } = validClaims;
      const result = EntraTokenClaimsSchema.safeParse(rest);
      expect(result.success).toBe(false);
    },
  );

  it("rejects claims where exp is not a number", () => {
    const result = EntraTokenClaimsSchema.safeParse({ ...validClaims, exp: "not-a-number" });
    expect(result.success).toBe(false);
  });
});

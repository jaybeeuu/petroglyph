// Machine-readable auth error reasons for deterministic failure handling.
// Each variant maps to a specific HTTP response and log message in the middleware.

export type AuthError =
  | { kind: "missing_token" }
  | { kind: "malformed_token"; detail: string }
  | { kind: "expired_token" }
  | { kind: "invalid_token"; detail: string }
  | { kind: "unknown_identity" }
  | { kind: "disabled_account" };

export const missingToken = (): AuthError => ({ kind: "missing_token" });
export const malformedToken = (detail: string): AuthError => ({ kind: "malformed_token", detail });
export const expiredToken = (): AuthError => ({ kind: "expired_token" });
export const invalidToken = (detail: string): AuthError => ({ kind: "invalid_token", detail });
export const unknownIdentity = (): AuthError => ({ kind: "unknown_identity" });
export const disabledAccount = (): AuthError => ({ kind: "disabled_account" });

export type TokenRequestOutcome =
  | { kind: "success"; accessToken: string; refreshToken: string; expiresIn: number }
  | { kind: "grant-invalid" };

export type ResolveOutcome =
  | { kind: "success"; accessToken: string }
  | { kind: "reconnect-required" };

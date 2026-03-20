import type { ApplicationUser } from "@petroglyph/account";

// API-owned resolved auth context. Handlers receive this after both token validation
// and identity-to-account resolution have succeeded. Handlers must not be called unless
// this context is present and fully resolved.
//
// This shape is intentionally API-owned and not shared into packages/core or packages/account,
// so the API layer can evolve what "resolved auth" means without changing shared kernel contracts.
export interface ResolvedAuthContext {
  readonly user: ApplicationUser;
}

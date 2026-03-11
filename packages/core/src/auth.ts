import type { ApplicationUserId } from "./ids.js";

// Carries the resolved application user identity through protected request handling.
// Handlers should operate on this context rather than raw token claims.
export interface AuthContext {
  userId: ApplicationUserId;
}

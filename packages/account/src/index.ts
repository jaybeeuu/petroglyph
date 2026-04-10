export type { AccountStatus, ApplicationUser, AuthIdentity } from "./account.js";
export { AccountStatusSchema, ApplicationUserSchema, AuthIdentitySchema } from "./account.js";

export type { AuthContext } from "./auth.js";

// deliberate lint error for CI verification
var badVariable = "this will fail lint";

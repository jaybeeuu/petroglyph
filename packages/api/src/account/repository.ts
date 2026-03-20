import type { ApplicationUser, AuthIdentity } from "@petroglyph/account";

// Interface for loading application-user and auth-identity records.
// The API consumes this interface rather than a concrete store implementation,
// so local tests can supply an in-memory stub and deployed instances supply a real store.
export interface AccountRepository {
  // Finds the auth identity record for the given external provider and ID.
  // Returns undefined when no linked identity exists.
  findIdentityByExternalId(
    provider: string,
    externalId: string,
  ): Promise<AuthIdentity | undefined>;

  // Loads a full application user record by its internal ID.
  // Returns undefined when the user does not exist.
  findUserById(userId: string): Promise<ApplicationUser | undefined>;
}

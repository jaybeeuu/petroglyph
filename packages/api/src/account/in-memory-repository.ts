import type { ApplicationUser, AuthIdentity } from "@petroglyph/account";
import type { AccountRepository } from "./repository.js";

// In-memory AccountRepository for local development and tests.
// Holds user and identity records in plain arrays; state resets when the process restarts.
export class InMemoryAccountRepository implements AccountRepository {
  readonly #users: ApplicationUser[];
  readonly #identities: AuthIdentity[];

  constructor(users: ApplicationUser[] = [], identities: AuthIdentity[] = []) {
    this.#users = users;
    this.#identities = identities;
  }

  async findIdentityByExternalId(
    provider: string,
    externalId: string,
  ): Promise<AuthIdentity | undefined> {
    return Promise.resolve(
      this.#identities.find(
        (identity) => identity.provider === provider && identity.externalId === externalId,
      ),
    );
  }

  async findUserById(userId: string): Promise<ApplicationUser | undefined> {
    return Promise.resolve(this.#users.find((user) => user.id === userId));
  }
}

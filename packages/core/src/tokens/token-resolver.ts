import type { TokenRecord, TokenStore } from "./token-store.js";

export type TokenRequestOutcome =
  | { kind: "success"; accessToken: string; refreshToken: string; expiresIn: number }
  | { kind: "grant-invalid" };

export type ResolveOutcome =
  | { kind: "success"; accessToken: string }
  | { kind: "reconnect-required" };

export interface TokenResolveOptions {
  /**
   * Explicit refresh-now mode (Q5): refresh regardless of the expired-guard.
   * Used by the graph-client 401-retry path, distinct from the guard
   * (`now >= expirySeconds`) which runs before returning a token.
   */
  force?: boolean;
}

export interface TokenResolver {
  resolveAccessToken(
    userId: string,
    provider: string,
    options?: TokenResolveOptions,
  ): Promise<ResolveOutcome>;
}

/**
 * Delegated OAuth session lifecycle, keyed by connection (userId, provider).
 * Rules:
 *  1. valid (now < expirySeconds) → stored token, zero MS calls;
 *  2. expired → refresh before returning; access+refresh rotate atomically;
 *  3. grant-invalid → persist reconnectRequired:true, never stale-fallback;
 *  4. reconnectRequired already true → immediate fast-fail;
 *  5. concurrent resolves on one connection → one in-flight MS call;
 *  6. different connections → independent calls;
 *  7. CAS conflict → refetch winner, never persist the loser's rotation;
 *  8. no record for the connection → reconnect-required.
 *
 * The class names the transport (OAuth); the `TokenResolver` interface stays
 * the consumer-facing capability.
 */
export class OAuthTokenResolver implements TokenResolver {
  readonly #store: TokenStore;
  readonly #now: () => number;
  readonly #requestTokens: (refreshToken: string) => Promise<TokenRequestOutcome>;
  readonly #inFlight = new Map<string, Promise<ResolveOutcome>>();

  constructor(options: {
    store: TokenStore;
    now: () => number;
    requestTokens: (refreshToken: string) => Promise<TokenRequestOutcome>;
  }) {
    this.#store = options.store;
    this.#now = options.now;
    this.#requestTokens = options.requestTokens;
  }

  resolveAccessToken(
    userId: string,
    provider: string,
    resolveOptions?: TokenResolveOptions,
  ): Promise<ResolveOutcome> {
    const key = `${userId}\u0000${provider}`;
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const pending = this.#resolveOnce(userId, provider, resolveOptions);
    this.#inFlight.set(key, pending);
    void pending.finally(() => {
      this.#inFlight.delete(key);
    });
    return pending;
  }

  async #resolveOnce(
    userId: string,
    provider: string,
    resolveOptions: TokenResolveOptions | undefined,
  ): Promise<ResolveOutcome> {
    const record = await this.#store.read(userId, provider);
    if (record === null) {
      return { kind: "reconnect-required" };
    }
    if (record.reconnectRequired) {
      return { kind: "reconnect-required" };
    }
    if (!resolveOptions?.force && this.#now() < record.expirySeconds) {
      return { kind: "success", accessToken: record.accessToken };
    }

    const outcome = await this.#requestTokens(record.refreshToken);
    if (outcome.kind === "grant-invalid") {
      await this.#persistReconnectRequired(userId, provider, record);
      return { kind: "reconnect-required" };
    }

    const rotated: TokenRecord = {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken,
      expirySeconds: Math.floor(this.#now()) + outcome.expiresIn,
      updatedAt: new Date().toISOString(),
      reconnectRequired: false,
    };

    const written = await this.#store.write(userId, provider, rotated, record);
    if (written) {
      return { kind: "success", accessToken: rotated.accessToken };
    }

    // CAS conflict: another writer rotated first — return the winner's token.
    const winner = await this.#store.read(userId, provider);
    if (winner === null || winner.reconnectRequired) {
      return { kind: "reconnect-required" };
    }
    return { kind: "success", accessToken: winner.accessToken };
  }

  async #persistReconnectRequired(
    userId: string,
    provider: string,
    record: TokenRecord,
  ): Promise<void> {
    const written = await this.#store.write(
      userId,
      provider,
      { ...record, reconnectRequired: true },
      record,
    );
    if (written && !record.reconnectRequired) {
      // The transition logs loudly exactly once; fast-fail resolves silently.
      console.error(
        `[token-resolver] connection ${userId}@${provider} entered reconnect-required (grant invalid)`,
      );
    }
  }
}

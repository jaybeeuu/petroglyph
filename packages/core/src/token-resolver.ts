import type { TokenRecord } from "./token-record.js";
import type { TokenStore } from "./token-store.js";
import type { ResolveOutcome, TokenRequestOutcome } from "./token-request.js";

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
 */
export function createTokenResolver(deps: {
  store: TokenStore;
  now: () => number;
  requestTokens: (refreshToken: string) => Promise<TokenRequestOutcome>;
}): TokenResolver {
  const inFlight = new Map<string, Promise<ResolveOutcome>>();

  return {
    resolveAccessToken(userId, provider, resolveOptions) {
      const key = `${userId}\u0000${provider}`;
      const existing = inFlight.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const pending = resolveOnce(userId, provider, resolveOptions);
      inFlight.set(key, pending);
      void pending.finally(() => {
        inFlight.delete(key);
      });
      return pending;
    },
  };

  async function resolveOnce(
    userId: string,
    provider: string,
    resolveOptions: TokenResolveOptions | undefined,
  ): Promise<ResolveOutcome> {
    const record = await deps.store.read(userId, provider);
    if (record === null) {
      return { kind: "reconnect-required" };
    }
    if (record.reconnectRequired) {
      return { kind: "reconnect-required" };
    }
    if (!resolveOptions?.force && deps.now() < record.expirySeconds) {
      return { kind: "success", accessToken: record.accessToken };
    }

    const outcome = await deps.requestTokens(record.refreshToken);
    if (outcome.kind === "grant-invalid") {
      await persistReconnectRequired(userId, provider, record);
      return { kind: "reconnect-required" };
    }

    const rotated: TokenRecord = {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken,
      expirySeconds: Math.floor(deps.now()) + outcome.expiresIn,
      updatedAt: new Date().toISOString(),
      reconnectRequired: false,
    };

    const written = await deps.store.write(userId, provider, rotated, record);
    if (written) {
      return { kind: "success", accessToken: rotated.accessToken };
    }

    // CAS conflict: another writer rotated first — return the winner's token.
    const winner = await deps.store.read(userId, provider);
    if (winner === null || winner.reconnectRequired) {
      return { kind: "reconnect-required" };
    }
    return { kind: "success", accessToken: winner.accessToken };
  }

  async function persistReconnectRequired(
    userId: string,
    provider: string,
    record: TokenRecord,
  ): Promise<void> {
    const written = await deps.store.write(
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

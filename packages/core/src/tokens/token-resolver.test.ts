import { describe, expect, it, vi } from "vitest";
import { OAuthTokenResolver } from "./token-resolver.js";
import type { TokenRequestOutcome } from "./token-resolver.js";
import type { TokenRecord, TokenStore } from "./token-store.js";

const CONNECTION = { userId: "github|12345", provider: "onedrive" };

const BASE_RECORD: TokenRecord = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expirySeconds: 1_000_000,
  updatedAt: "2026-09-01T00:00:00.000Z",
  reconnectRequired: false,
};

function makeTokenRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return { ...BASE_RECORD, ...overrides };
}

function makeTokenResponseOutcome(
  overrides: Partial<TokenRequestOutcome> = {},
): TokenRequestOutcome {
  if (overrides.kind === "grant-invalid") {
    return { kind: "grant-invalid" };
  }
  return {
    kind: "success",
    accessToken: "access-fresh",
    refreshToken: "refresh-rotated",
    expiresIn: 3600,
    ...overrides,
  };
}

interface InMemoryTokenStoreOptions {
  records?: Map<string, TokenRecord>;
}

interface RecordedWrite {
  record: TokenRecord;
  expected: TokenRecord | undefined;
}

/**
 * Test double for the per-connection token vault. Exposes the records it holds
 * and the writes it observed so tests can assert persistence semantics.
 */
class InMemoryTokenStore implements TokenStore {
  readonly records: Map<string, TokenRecord>;
  readonly writes: RecordedWrite[] = [];

  constructor(options: InMemoryTokenStoreOptions = {}) {
    this.records = options.records ?? new Map<string, TokenRecord>();
  }

  read(userId: string, provider: string): Promise<TokenRecord | null> {
    return Promise.resolve(this.records.get(`${userId}:${provider}`) ?? null);
  }

  write(
    userId: string,
    provider: string,
    record: TokenRecord,
    expected?: TokenRecord,
  ): Promise<boolean> {
    this.writes.push({ record, expected });
    const key = `${userId}:${provider}`;
    if (expected === undefined) {
      this.records.set(key, record);
      return Promise.resolve(true);
    }
    const current = this.records.get(key);
    if (current?.updatedAt !== expected.updatedAt) {
      return Promise.resolve(false);
    }
    this.records.set(key, record);
    return Promise.resolve(true);
  }
}

describe("OAuthTokenResolver", () => {
  it("returns the stored token when not expired — requestTokens never called", async () => {
    const store = new InMemoryTokenStore({
      records: new Map([["github|12345:onedrive", makeTokenRecord()]]),
    });
    const requestTokens = vi.fn();
    const resolver = new OAuthTokenResolver({ store, now: () => 500_000, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "success", accessToken: "access-1" });
    expect(requestTokens).not.toHaveBeenCalled();
  });

  it("refreshes before returning an expired token; access+refresh persist together; never returns expired", async () => {
    const store = new InMemoryTokenStore({
      records: new Map([["github|12345:onedrive", makeTokenRecord({ expirySeconds: 100 })]]),
    });
    const requestTokens = vi.fn().mockResolvedValue(makeTokenResponseOutcome());
    const now = vi.fn().mockReturnValue(200);
    const resolver = new OAuthTokenResolver({ store, now, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "success", accessToken: "access-fresh" });
    expect(requestTokens).toHaveBeenCalledWith("refresh-1");
    // atomic persist: one write carrying access+refresh+expiry together
    expect(store.writes).toHaveLength(1);
    const write = store.writes[0] as { record: TokenRecord; expected: TokenRecord | undefined };
    expect(write.record).toMatchObject({
      accessToken: "access-fresh",
      refreshToken: "refresh-rotated",
      expirySeconds: 200 + 3600,
      reconnectRequired: false,
    });
    expect(write.expected).toEqual(makeTokenRecord({ expirySeconds: 100 }));
  });

  it("grant-invalid persists reconnectRequired and returns reconnect-required — no stale fallback", async () => {
    const store = new InMemoryTokenStore({
      records: new Map([
        [
          "github|12345:onedrive",
          makeTokenRecord({ accessToken: "access-stale", expirySeconds: 100 }),
        ],
      ]),
    });
    const requestTokens = vi.fn().mockResolvedValue({ kind: "grant-invalid" });
    const resolver = new OAuthTokenResolver({ store, now: () => 200, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "reconnect-required" });
    const stored = store.records.get("github|12345:onedrive");
    expect(stored?.reconnectRequired).toBe(true);
    expect(stored?.accessToken).toBe("access-stale"); // old fields kept
  });

  it("fast-fails a record already marked reconnectRequired with zero MS calls", async () => {
    const store = new InMemoryTokenStore({
      records: new Map([["github|12345:onedrive", makeTokenRecord({ reconnectRequired: true })]]),
    });
    const requestTokens = vi.fn();
    const resolver = new OAuthTokenResolver({ store, now: () => 500_000, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "reconnect-required" });
    expect(requestTokens).not.toHaveBeenCalled();
  });

  it("returns reconnect-required when no record exists for the connection", async () => {
    const store = new InMemoryTokenStore();
    const requestTokens = vi.fn();
    const resolver = new OAuthTokenResolver({ store, now: () => 500_000, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "reconnect-required" });
    expect(requestTokens).not.toHaveBeenCalled();
  });

  it("serializes concurrent refreshes for the same connection — one MS call, both get the winner token", async () => {
    const store = new InMemoryTokenStore({
      records: new Map([["github|12345:onedrive", makeTokenRecord({ expirySeconds: 100 })]]),
    });
    let release!: (outcome: TokenRequestOutcome) => void;
    const parked = new Promise<TokenRequestOutcome>((resolve) => {
      release = resolve;
    });
    const requestTokens = vi.fn().mockReturnValue(parked);
    const resolver = new OAuthTokenResolver({ store, now: () => 200, requestTokens });

    const first = resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);
    const second = resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    release(makeTokenResponseOutcome());
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(requestTokens).toHaveBeenCalledTimes(1);
    expect(firstOutcome).toEqual({ kind: "success", accessToken: "access-fresh" });
    expect(secondOutcome).toEqual({ kind: "success", accessToken: "access-fresh" });
  });

  it("keeps refreshes for different connections independent", async () => {
    const store = new InMemoryTokenStore({
      records: new Map([
        ["github|12345:onedrive", makeTokenRecord({ expirySeconds: 100 })],
        ["github|99999:onedrive", makeTokenRecord({ expirySeconds: 100 })],
      ]),
    });
    const requestTokens = vi
      .fn()
      .mockResolvedValue(
        makeTokenResponseOutcome({ accessToken: "access-x", refreshToken: "refresh-x" }),
      );
    const resolver = new OAuthTokenResolver({ store, now: () => 200, requestTokens });

    const [a, b] = await Promise.all([
      resolver.resolveAccessToken("github|12345", "onedrive"),
      resolver.resolveAccessToken("github|99999", "onedrive"),
    ]);

    expect(requestTokens).toHaveBeenCalledTimes(2);
    expect(a).toEqual({ kind: "success", accessToken: "access-x" });
    expect(b).toEqual({ kind: "success", accessToken: "access-x" });
  });

  it("on CAS conflict the loser refetches and returns the winner's token; the loser's rotation never persists", async () => {
    const STALE_UPDATED_AT = BASE_RECORD.updatedAt;
    const winnerRecord = makeTokenRecord({
      accessToken: "winner-token",
      refreshToken: "winner-refresh",
      expirySeconds: 200 + 3600,
      updatedAt: "2026-09-01T00:00:01.000Z",
    });
    const records = new Map([
      [`${CONNECTION.userId}:${CONNECTION.provider}`, makeTokenRecord({ expirySeconds: 100 })],
    ]);
    const writes: { record: TokenRecord; expected: TokenRecord | undefined }[] = [];
    const store: TokenStore = {
      read(userId, provider) {
        return Promise.resolve(records.get(`${userId}:${provider}`) ?? null);
      },
      write(userId, provider, record, expected) {
        writes.push({ record, expected });
        const key = `${userId}:${provider}`;
        if (expected?.updatedAt === STALE_UPDATED_AT) {
          // The winner rotated between the loser's read and CAS attempt.
          records.set(key, winnerRecord);
          return Promise.resolve(false);
        }
        records.set(key, record);
        return Promise.resolve(true);
      },
    };
    const requestTokens = vi
      .fn()
      .mockResolvedValue(
        makeTokenResponseOutcome({ accessToken: "loser-token", refreshToken: "loser-refresh" }),
      );
    const resolver = new OAuthTokenResolver({ store, now: () => 200, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "success", accessToken: "winner-token" });
    const stored = records.get(`${CONNECTION.userId}:${CONNECTION.provider}`);
    expect(stored?.accessToken).toBe("winner-token");
    expect(stored?.refreshToken).toBe("winner-refresh");
    expect(stored?.updatedAt).toBe(winnerRecord.updatedAt);
  });

  it("force mode refreshes even when the stored token is still valid", async () => {
    const store = new InMemoryTokenStore({
      records: new Map([["github|12345:onedrive", makeTokenRecord()]]),
    });
    const requestTokens = vi.fn().mockResolvedValue(makeTokenResponseOutcome());
    const resolver = new OAuthTokenResolver({ store, now: () => 500_000, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider, {
      force: true,
    });

    expect(requestTokens).toHaveBeenCalledWith("refresh-1");
    expect(outcome).toEqual({ kind: "success", accessToken: "access-fresh" });
    expect(store.records.get("github|12345:onedrive")?.accessToken).toBe("access-fresh");
  });
});

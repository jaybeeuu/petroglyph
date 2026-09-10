import { describe, expect, it, vi } from "vitest";
import { createTokenResolver } from "./token-resolver.js";
import type { TokenRecord } from "./token-record.js";
import type { TokenStore } from "./token-store.js";
import type { TokenRequestOutcome } from "./token-request.js";

const CONNECTION = { userId: "github|12345", provider: "onedrive" };

const validRecord: TokenRecord = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expirySeconds: 1_000_000,
  updatedAt: "2026-09-01T00:00:00.000Z",
  reconnectRequired: false,
};

const expiredRecord: TokenRecord = {
  ...validRecord,
  accessToken: "access-stale",
  expirySeconds: 100,
};

function successOutcome(
  accessToken = "access-fresh",
  refreshToken = "refresh-rotated",
  expiresIn = 3600,
): TokenRequestOutcome {
  return { kind: "success", accessToken, refreshToken, expiresIn };
}

interface MemStoreOptions {
  records?: Map<string, TokenRecord>;
}

function makeMemStore(options: MemStoreOptions = {}): TokenStore & {
  records: Map<string, TokenRecord>;
  writes: { record: TokenRecord; expected: TokenRecord | undefined }[];
} {
  const records = options.records ?? new Map<string, TokenRecord>();
  const writes: { record: TokenRecord; expected: TokenRecord | undefined }[] = [];
  return {
    records,
    writes,
    read(userId, provider) {
      return Promise.resolve(records.get(`${userId}:${provider}`) ?? null);
    },
    write(userId, provider, record, expected) {
      writes.push({ record, expected });
      const key = `${userId}:${provider}`;
      if (expected === undefined) {
        records.set(key, record);
        return Promise.resolve(true);
      }
      const current = records.get(key);
      if (current?.updatedAt !== expected.updatedAt) {
        return Promise.resolve(false);
      }
      records.set(key, record);
      return Promise.resolve(true);
    },
  };
}

describe("createTokenResolver", () => {
  it("returns the stored token when not expired — requestTokens never called", async () => {
    const store = makeMemStore({ records: new Map([["github|12345:onedrive", validRecord]]) });
    const requestTokens = vi.fn();
    const resolver = createTokenResolver({ store, now: () => 500_000, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "success", accessToken: "access-1" });
    expect(requestTokens).not.toHaveBeenCalled();
  });

  it("refreshes before returning an expired token; access+refresh persist together; never returns expired", async () => {
    const store = makeMemStore({ records: new Map([["github|12345:onedrive", expiredRecord]]) });
    const requestTokens = vi.fn().mockResolvedValue(successOutcome());
    const now = vi.fn().mockReturnValue(200);
    const resolver = createTokenResolver({ store, now, requestTokens });

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
    expect(write.expected).toEqual(expiredRecord);
  });

  it("grant-invalid persists reconnectRequired and returns reconnect-required — no stale fallback", async () => {
    const store = makeMemStore({ records: new Map([["github|12345:onedrive", expiredRecord]]) });
    const requestTokens = vi.fn().mockResolvedValue({ kind: "grant-invalid" });
    const resolver = createTokenResolver({ store, now: () => 200, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "reconnect-required" });
    const stored = store.records.get("github|12345:onedrive");
    expect(stored?.reconnectRequired).toBe(true);
    expect(stored?.accessToken).toBe("access-stale"); // old fields kept
  });

  it("fast-fails a record already marked reconnectRequired with zero MS calls", async () => {
    const store = makeMemStore({
      records: new Map([["github|12345:onedrive", { ...validRecord, reconnectRequired: true }]]),
    });
    const requestTokens = vi.fn();
    const resolver = createTokenResolver({ store, now: () => 500_000, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "reconnect-required" });
    expect(requestTokens).not.toHaveBeenCalled();
  });

  it("returns reconnect-required when no record exists for the connection", async () => {
    const store = makeMemStore();
    const requestTokens = vi.fn();
    const resolver = createTokenResolver({ store, now: () => 500_000, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "reconnect-required" });
    expect(requestTokens).not.toHaveBeenCalled();
  });

  it("serializes concurrent refreshes for the same connection — one MS call, both get the winner token", async () => {
    const store = makeMemStore({ records: new Map([["github|12345:onedrive", expiredRecord]]) });
    let release!: (outcome: TokenRequestOutcome) => void;
    const parked = new Promise<TokenRequestOutcome>((resolve) => {
      release = resolve;
    });
    const requestTokens = vi.fn().mockReturnValue(parked);
    const resolver = createTokenResolver({ store, now: () => 200, requestTokens });

    const first = resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);
    const second = resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    release(successOutcome());
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(requestTokens).toHaveBeenCalledTimes(1);
    expect(firstOutcome).toEqual({ kind: "success", accessToken: "access-fresh" });
    expect(secondOutcome).toEqual({ kind: "success", accessToken: "access-fresh" });
  });

  it("keeps refreshes for different connections independent", async () => {
    const store = makeMemStore({
      records: new Map([
        ["github|12345:onedrive", expiredRecord],
        ["github|99999:onedrive", expiredRecord],
      ]),
    });
    const requestTokens = vi.fn().mockResolvedValue(successOutcome("access-x", "refresh-x"));
    const resolver = createTokenResolver({ store, now: () => 200, requestTokens });

    const [a, b] = await Promise.all([
      resolver.resolveAccessToken("github|12345", "onedrive"),
      resolver.resolveAccessToken("github|99999", "onedrive"),
    ]);

    expect(requestTokens).toHaveBeenCalledTimes(2);
    expect(a).toEqual({ kind: "success", accessToken: "access-x" });
    expect(b).toEqual({ kind: "success", accessToken: "access-x" });
  });

  it("on CAS conflict the loser refetches and returns the winner's token; the loser's rotation never persists", async () => {
    const STALE_UPDATED_AT = expiredRecord.updatedAt;
    const winnerRecord: TokenRecord = {
      accessToken: "winner-token",
      refreshToken: "winner-refresh",
      expirySeconds: 200 + 3600,
      updatedAt: "2026-09-01T00:00:01.000Z",
      reconnectRequired: false,
    };
    const records = new Map([[`${CONNECTION.userId}:${CONNECTION.provider}`, expiredRecord]]);
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
    const requestTokens = vi.fn().mockResolvedValue(successOutcome("loser-token", "loser-refresh"));
    const resolver = createTokenResolver({ store, now: () => 200, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider);

    expect(outcome).toEqual({ kind: "success", accessToken: "winner-token" });
    const stored = records.get(`${CONNECTION.userId}:${CONNECTION.provider}`);
    expect(stored?.accessToken).toBe("winner-token");
    expect(stored?.refreshToken).toBe("winner-refresh");
    expect(stored?.updatedAt).toBe(winnerRecord.updatedAt);
  });

  it("force mode refreshes even when the stored token is still valid", async () => {
    const store = makeMemStore({ records: new Map([["github|12345:onedrive", validRecord]]) });
    const requestTokens = vi.fn().mockResolvedValue(successOutcome());
    const resolver = createTokenResolver({ store, now: () => 500_000, requestTokens });

    const outcome = await resolver.resolveAccessToken(CONNECTION.userId, CONNECTION.provider, {
      force: true,
    });

    expect(requestTokens).toHaveBeenCalledWith("refresh-1");
    expect(outcome).toEqual({ kind: "success", accessToken: "access-fresh" });
    expect(store.records.get("github|12345:onedrive")?.accessToken).toBe("access-fresh");
  });
});

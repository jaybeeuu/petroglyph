import type { TokenRecord } from "./token-record.js";

/**
 * Per-connection token vault (keyed userId+provider — the credentialed unit
 * is the user×provider grant, shared by all profiles on the connection).
 */
export interface TokenStore {
  read(userId: string, provider: string): Promise<TokenRecord | null>;
  /**
   * CAS semantics: expected === undefined → blind create/overwrite (bootstrap
   * only); expected === record → atomic compare-and-set, false when another
   * writer won the race.
   */
  write(
    userId: string,
    provider: string,
    record: TokenRecord,
    expected?: TokenRecord,
  ): Promise<boolean>;
}

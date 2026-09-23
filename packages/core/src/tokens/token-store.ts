export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds at which the access token expires. */
  expirySeconds: number;
  updatedAt: string;
  /** Grant died (invalid_grant); sticky until /connect rewrites tokens. */
  reconnectRequired: boolean;
}

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

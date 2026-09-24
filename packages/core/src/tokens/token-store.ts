import { z } from "zod";

/**
 * Persisted token-record shape. Core owns the schema so the token store's
 * DynamoDB read boundary validates against the same definition that types the
 * resolver — one shape, one owner.
 */
export const tokenRecordSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Epoch seconds at which the access token expires. */
  expirySeconds: z.number().int().positive(),
  updatedAt: z.string().min(1),
  /** Grant died (invalid_grant); sticky until /connect rewrites tokens. */
  reconnectRequired: z.boolean(),
});

export type TokenRecord = z.infer<typeof tokenRecordSchema>;

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

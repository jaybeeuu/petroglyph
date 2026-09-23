export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds at which the access token expires. */
  expirySeconds: number;
  updatedAt: string;
  /** Grant died (invalid_grant); sticky until /connect rewrites tokens. */
  reconnectRequired: boolean;
}

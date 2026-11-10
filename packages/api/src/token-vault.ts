import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { tokenRecordSchema, type TokenRecord } from "@petroglyph/core";

/** The provider half of the connection key — OneDrive is the only adapter today. */
export const ONEDRIVE_PROVIDER = "onedrive";

export function tokenVaultsTableName(): string {
  return process.env["TOKEN_VAULTS_TABLE"] ?? "petroglyph-token-vaults-default";
}

export interface InitialConnectionTokens {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

/**
 * Seeds the connection-keyed token vault from an OAuth consent.
 *
 * The OneDrive adapter resolves the grant from this row; without it a consent
 * is invisible to the data path and every resolve fast-fails as
 * `reconnectRequired`. A blind put is correct here: `/connect` is the only
 * bootstrap writer, and the row it writes clears any sticky reconnect flag.
 *
 * The legacy `refresh_tokens` record is written alongside this one until
 * Delivery 3 retires the old copies.
 */
export async function writeInitialConnectionTokens(
  client: DynamoDBDocumentClient,
  tokens: InitialConnectionTokens,
): Promise<void> {
  const now = new Date();
  const record: TokenRecord = tokenRecordSchema.parse({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expirySeconds: Math.floor(now.getTime() / 1000) + tokens.expiresInSeconds,
    updatedAt: now.toISOString(),
    reconnectRequired: false,
  });

  await client.send(
    new PutCommand({
      TableName: tokenVaultsTableName(),
      Item: { userId: tokens.userId, provider: ONEDRIVE_PROVIDER, ...record },
    }),
  );
}

/**
 * The stored connection for one (userId, provider), or null when onboarding
 * never completed. This reads the vault and nothing else: it resolves no access
 * token and refreshes no grant, so a caller that only needs the connection's
 * state cannot reach the provider.
 *
 * A row that fails `tokenRecordSchema` throws rather than reporting a healthy
 * connection: guessing a state from a malformed row would either enqueue a walk
 * that cannot succeed or refuse one that can.
 */
export async function readConnection(
  client: DynamoDBDocumentClient,
  userId: string,
  provider: string,
): Promise<TokenRecord | null> {
  const result = await client.send(
    new GetCommand({
      TableName: tokenVaultsTableName(),
      Key: { userId, provider },
    }),
  );

  return result.Item === undefined ? null : tokenRecordSchema.parse(result.Item);
}

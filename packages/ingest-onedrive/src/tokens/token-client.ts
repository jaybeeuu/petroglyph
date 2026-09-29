import { z } from "zod";
import type { TokenRequestOutcome } from "@petroglyph/core";

export const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

const tokenErrorSchema = z.object({
  error: z.string().min(1),
});

/**
 * Parses a Microsoft token-endpoint response into our vocabulary. Shared by
 * the refresh client and the auth bootstrap exchange (same endpoint, same
 * response shape).
 */
export async function parseTokenResponse(response: Response): Promise<TokenRequestOutcome> {
  const body: unknown = await response.json();

  if (!response.ok) {
    const error = tokenErrorSchema.safeParse(body);
    if (error.success && error.data.error === "invalid_grant") {
      return { kind: "grant-invalid" };
    }
    throw new Error(`Token request failed with status ${response.status}`);
  }

  const tokens = tokenResponseSchema.parse(body);
  return {
    kind: "success",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  };
}

export interface TokenClientOptions {
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
}

export interface TokenClient {
  requestTokens(refreshToken: string): Promise<TokenRequestOutcome>;
}

/** The adapter's MS token endpoint client — the only place OAuth speaks Microsoft. */
export class OAuthTokenClient implements TokenClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetchFn: typeof fetch;

  constructor(options: TokenClientOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#fetchFn = options.fetchFn ?? fetch;
  }

  async requestTokens(refreshToken: string): Promise<TokenRequestOutcome> {
    const body = new URLSearchParams({
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "files.readwrite offline_access",
    });

    const response = await this.#fetchFn(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    return parseTokenResponse(response);
  }
}

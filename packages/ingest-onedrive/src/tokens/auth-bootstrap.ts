import { z } from "zod";
import type { TokenRequestOutcome, TokenRecord, TokenStore } from "@petroglyph/core";
import { TOKEN_ENDPOINT, parseTokenResponse } from "./token-client.js";

export interface AuthBootstrapLoginOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
}

export interface AuthUrlOptions {
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  /** Opaque CSRF token — passed through verbatim, never inspected. */
  state: string;
}

/** The connect bootstrap's authorize URL (6.6.5's HTTP surface calls this). */
export function buildAuthUrl(options: AuthUrlOptions): string {
  const scope = (options.scopes ?? ["files.readwrite", "offline_access"]).join(" ");
  const params = new URLSearchParams({
    client_id: options.clientId,
    response_type: "code",
    redirect_uri: options.redirectUri,
    scope,
    state: options.state,
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  options: AuthBootstrapLoginOptions & { code: string },
): Promise<TokenRequestOutcome> {
  const fetchFn = options.fetchFn ?? fetch;
  const params = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    code: options.code,
    grant_type: "authorization_code",
  });

  const response = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  return parseTokenResponse(response);
}

export async function storeInitialTokens(options: {
  store: TokenStore;
  userId: string;
  provider: string;
  outcome: TokenRequestOutcome;
}): Promise<void> {
  if (options.outcome.kind === "grant-invalid") {
    return;
  }
  const record: TokenRecord = {
    accessToken: options.outcome.accessToken,
    refreshToken: options.outcome.refreshToken,
    expirySeconds: Math.floor(Date.now() / 1000) + options.outcome.expiresIn,
    updatedAt: new Date().toISOString(),
    reconnectRequired: false,
  };
  // expected: undefined — bootstrap is blind; /connect is the only writer here.
  await options.store.write(options.userId, options.provider, record, undefined);
}

// zod is the validation standard for external shapes; keep the import visible
// for future code paths that validate bootstrap inputs.
export const authUrlInputSchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.url(),
  scopes: z.array(z.string().min(1)).optional(),
  state: z.string().min(1),
});

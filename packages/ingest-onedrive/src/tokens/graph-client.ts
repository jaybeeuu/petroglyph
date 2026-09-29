import type { ResolveOutcome } from "@petroglyph/core";

export interface GraphRequestInit {
  method?: string;
  headers?: { [key: string]: string };
  body?: string | Uint8Array | URLSearchParams;
}

export interface GraphClient {
  /** Raw Response passthrough — the /content download is never buffered here. */
  request(path: string, init?: GraphRequestInit): Promise<Response>;
}

export interface GraphClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  /**
   * Resolver bound to one connection. The 401-retry path calls it with
   * { force: true } — an explicit refresh-now, distinct from the guard.
   */
  resolveAccessToken: (options?: { force?: boolean }) => Promise<ResolveOutcome>;
}

/**
 * Thin wrapper: Bearer injection + 401 → force-refresh → retry ONCE. No
 * 429/5xx backoff here (walker pacing concern) and no 403 retry (masking).
 */
export class MicrosoftGraphClient implements GraphClient {
  readonly #baseUrl: string;
  readonly #fetchFn: typeof fetch;
  readonly #resolveAccessToken: (options?: { force?: boolean }) => Promise<ResolveOutcome>;

  constructor(options: GraphClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#resolveAccessToken = options.resolveAccessToken;
  }

  async request(path: string, init?: GraphRequestInit): Promise<Response> {
    const first = await this.#sendWithBearer(path, init);
    if (first.status !== 401) {
      return first;
    }

    // 401: the token died unpredictably (rotation race/revocation/skew).
    const refreshed = await this.#resolveAccessToken({ force: true });
    if (refreshed.kind === "reconnect-required") {
      return first; // surface the 401 — disconnected, no second round-trip
    }

    return this.#sendWithBearer(path, init, refreshed.accessToken);
  }

  async #sendWithBearer(
    path: string,
    init: GraphRequestInit | undefined,
    tokenOverride?: string,
  ): Promise<Response> {
    if (tokenOverride !== undefined) {
      return this.#fetchWithAuth(path, init, tokenOverride);
    }
    const outcome = await this.#resolveAccessToken();
    if (outcome.kind === "reconnect-required") {
      return new Response("", {
        status: 401,
        headers: { "x-petroglyph-disconnected": "reconnect-required" },
      });
    }
    return this.#fetchWithAuth(path, init, outcome.accessToken);
  }

  #fetchWithAuth(
    path: string,
    init: GraphRequestInit | undefined,
    token: string,
  ): Promise<Response> {
    return this.#fetchFn(resolveUrl(this.#baseUrl, path), {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    });
  }
}

/**
 * Graph's deltaLink/nextLink values are absolute URLs; the walker hands
 * them back to the client verbatim, so an absolute path must never be
 * re-prefixed with baseUrl.
 */
function resolveUrl(baseUrl: string, path: string): string {
  return /^https?:\/\//.test(path) ? path : `${baseUrl}${path}`;
}

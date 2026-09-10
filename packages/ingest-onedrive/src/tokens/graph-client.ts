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
export function createGraphClient(options: GraphClientOptions): GraphClient {
  const fetchFn = options.fetchFn ?? fetch;
  return {
    async request(path, init) {
      const first = await sendWithBearer(path, init);
      if (first.status !== 401) {
        return first;
      }

      // 401: the token died unpredictably (rotation race/revocation/skew).
      const refreshed = await options.resolveAccessToken({ force: true });
      if (refreshed.kind === "reconnect-required") {
        return first; // surface the 401 — disconnected, no second round-trip
      }

      return sendWithBearer(path, init, refreshed.accessToken);
    },
  };

  async function sendWithBearer(
    path: string,
    init: GraphRequestInit | undefined,
    tokenOverride?: string,
  ): Promise<Response> {
    if (tokenOverride !== undefined) {
      return fetchWithAuth(path, init, tokenOverride);
    }
    const outcome = await options.resolveAccessToken();
    if (outcome.kind === "reconnect-required") {
      return new Response("", {
        status: 401,
        headers: { "x-petroglyph-disconnected": "reconnect-required" },
      });
    }
    return fetchWithAuth(path, init, outcome.accessToken);
  }

  function fetchWithAuth(
    path: string,
    init: GraphRequestInit | undefined,
    token: string,
  ): Promise<Response> {
    return fetchFn(`${options.baseUrl}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    });
  }
}

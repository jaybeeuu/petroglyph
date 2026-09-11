import { describe, expect, it, vi } from "vitest";
import { createGraphClient } from "./graph-client.js";
import type { ResolveOutcome } from "@petroglyph/core";

function scriptedResolver(outcomes: ResolveOutcome[]): {
  resolveAccessToken: (options?: { force?: boolean }) => Promise<ResolveOutcome>;
  calls: () => { force?: boolean }[];
} {
  const fn = vi.fn<(options?: { force?: boolean }) => Promise<ResolveOutcome>>();
  fn.mockImplementation(() => Promise.resolve(outcomes.shift() ?? { kind: "reconnect-required" }));
  const calls = (): { force?: boolean }[] => fn.mock.calls.map((call) => call[0] ?? {});
  return { resolveAccessToken: fn, calls };
}

const response = (status: number): Response => new Response(null, { status });

describe("createGraphClient", () => {
  it("sends every request with a Bearer token from the resolver", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200));
    const { resolveAccessToken } = scriptedResolver([{ kind: "success", accessToken: "tok-1" }]);

    const client = createGraphClient({
      baseUrl: "https://graph.microsoft.com/v1.0",
      fetchFn,
      resolveAccessToken,
    });

    const result = await client.request("/me/drive/root/delta");

    expect(result.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, { headers: { [key: string]: string } }];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/drive/root/delta");
    expect(init.headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("on 401 force-refreshes once, retries once with the fresh token, then surfaces a repeated 401", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200));
    const { resolveAccessToken, calls } = scriptedResolver([
      { kind: "success", accessToken: "stale-tok" },
      { kind: "success", accessToken: "fresh-tok" },
    ]);

    const client = createGraphClient({
      baseUrl: "https://graph.microsoft.com/v1.0",
      fetchFn,
      resolveAccessToken,
    });

    const result = await client.request("/me/drive/items/item-1/content");

    expect(result.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const retryInit = fetchFn.mock.calls[1]?.[1] as { headers: { [key: string]: string } };
    expect(retryInit.headers["Authorization"]).toBe("Bearer fresh-tok");
    // first resolve = guard path, second = explicit force-refresh
    expect(calls()).toEqual([{ force: undefined }, { force: true }]);
  });

  it("surfaces the 401 without retrying when force-refresh lands on reconnect-required", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(401));
    const { resolveAccessToken, calls } = scriptedResolver([
      { kind: "success", accessToken: "stale-tok" },
      { kind: "reconnect-required" },
    ]);

    const client = createGraphClient({
      baseUrl: "https://graph.microsoft.com/v1.0",
      fetchFn,
      resolveAccessToken,
    });

    const result = await client.request("/me/drive/root/delta");

    expect(result.status).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls().filter((call) => call.force === true)).toHaveLength(1);
  });

  it("uses an absolute URL verbatim (deltaLink/nextLink from Graph are absolute)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(200));
    const { resolveAccessToken } = scriptedResolver([{ kind: "success", accessToken: "tok-1" }]);

    const client = createGraphClient({
      baseUrl: "https://graph.microsoft.com/v1.0",
      fetchFn,
      resolveAccessToken,
    });

    const absolute = "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=opaque-abc";
    const result = await client.request(absolute);

    expect(result.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url).toBe(absolute);
  });

  it("returns an immediate 401 and never calls Graph when the resolver fast-fails at entry", async () => {
    const fetchFn = vi.fn();
    const { resolveAccessToken } = scriptedResolver([{ kind: "reconnect-required" }]);

    const client = createGraphClient({
      baseUrl: "https://graph.microsoft.com/v1.0",
      fetchFn,
      resolveAccessToken,
    });

    const result = await client.request("/me/drive/root/delta");

    expect(result.status).toBe(401);
    expect(result.headers.get("x-petroglyph-disconnected")).toBe("reconnect-required");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("passes the /content response through unread", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("pdf-bytes"));
        controller.close();
      },
    });
    const contentResponse = new Response(body, { status: 200 });
    const fetchFn = vi.fn().mockResolvedValue(contentResponse);
    const { resolveAccessToken } = scriptedResolver([{ kind: "success", accessToken: "tok-1" }]);

    const client = createGraphClient({
      baseUrl: "https://graph.microsoft.com/v1.0",
      fetchFn,
      resolveAccessToken,
    });

    const result = await client.request("/me/drive/items/item-1/content");

    // the raw Response is returned untouched — the download is never buffered here
    expect(result).toBe(contentResponse);
  });
});

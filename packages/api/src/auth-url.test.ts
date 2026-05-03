import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("./db.js", () => ({
  docClient: { send: mockSend },
}));

import { app } from "./app.js";

describe("GET /auth/url", () => {
  const returnUri = "obsidian://petroglyph/open";

  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
    vi.stubEnv("GITHUB_REDIRECT_URI", "obsidian://petroglyph/auth/callback");
    mockSend.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 400 when returnUri is missing", async () => {
    const res = await app.request("/auth/url");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "returnUri is required" });
  });

  it("returns 400 when returnUri is empty", async () => {
    const res = await app.request("/auth/url?returnUri=");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "returnUri is required" });
  });

  it("returns 200 with a url field", async () => {
    const res = await app.request(`/auth/url?returnUri=${encodeURIComponent(returnUri)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(typeof body.url).toBe("string");
  });

  it("URL contains correct query params", async () => {
    const res = await app.request(`/auth/url?returnUri=${encodeURIComponent(returnUri)}`);
    const body = (await res.json()) as { url: string };
    const url = new URL(body.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("obsidian://petroglyph/auth/callback");
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("two calls produce distinct state tokens", async () => {
    const res1 = await app.request(`/auth/url?returnUri=${encodeURIComponent(returnUri)}`);
    const res2 = await app.request(`/auth/url?returnUri=${encodeURIComponent(returnUri)}`);
    const body1 = (await res1.json()) as { url: string };
    const body2 = (await res2.json()) as { url: string };
    const state1 = new URL(body1.url).searchParams.get("state");
    const state2 = new URL(body2.url).searchParams.get("state");
    expect(state1).not.toBe(state2);
  });

  it("stores state token in DynamoDB with TTL, type=oauth_state, and returnUri", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await app.request(`/auth/url?returnUri=${encodeURIComponent(returnUri)}`);
    const after = Math.floor(Date.now() / 1000);
    const body = (await res.json()) as { url: string };
    const state = new URL(body.url).searchParams.get("state");

    expect(mockSend).toHaveBeenCalledOnce();
    const [command] = mockSend.mock.calls[0] as [
      {
        input: {
          TableName: string;
          Item: { tokenHash: string; type: string; ttl: number; returnUri: string };
        };
      },
    ];
    expect(command.input).toMatchObject({
      TableName: "petroglyph-refresh_tokens-default",
      Item: {
        tokenHash: state,
        type: "oauth_state",
        returnUri,
      },
    });
    expect(command.input.Item.ttl).toBeGreaterThanOrEqual(before + 600);
    expect(command.input.Item.ttl).toBeLessThanOrEqual(after + 600);
  });
});

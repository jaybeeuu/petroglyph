import { describe, expect, it, vi } from "vitest";
import type { TokenStore } from "@petroglyph/core";
import { buildAuthUrl, exchangeCodeForTokens, storeInitialTokens } from "./auth-bootstrap.js";

const okResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const successBody = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_in: 3600,
  token_type: "Bearer",
};

describe("buildAuthUrl", () => {
  it("builds an authorize URL with endpoint params, scopes and opaque state passthrough", () => {
    const url = buildAuthUrl({
      clientId: "client-1",
      redirectUri: "https://app.petroglyph.dev/callback",
      state: "opaque-csrf-token",
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(parsed.searchParams.get("client_id")).toBe("client-1");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.petroglyph.dev/callback");
    expect(parsed.searchParams.get("state")).toBe("opaque-csrf-token");
    const scope = parsed.searchParams.get("scope");
    expect(scope).toContain("files.readwrite");
    expect(scope).toContain("offline_access");
  });

  it("honours an explicit scope list", () => {
    const url = buildAuthUrl({
      clientId: "client-1",
      redirectUri: "https://app.petroglyph.dev/callback",
      scopes: ["files.read"],
      state: "state-1",
    });

    expect(new URL(url).searchParams.get("scope")).toBe("files.read");
  });
});

describe("exchangeCodeForTokens", () => {
  it("exchanges a code for tokens via the token endpoint form", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse(successBody));
    const outcome = await exchangeCodeForTokens({
      clientId: "client-1",
      clientSecret: "secret-1",
      redirectUri: "https://app.petroglyph.dev/callback",
      code: "auth-code-1",
      fetchFn,
    });

    expect(outcome).toEqual({
      kind: "success",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 3600,
    });
    const [url, init] = fetchFn.mock.calls[0] as [
      string,
      { headers: { [key: string]: string }; body: string },
    ];
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("redirect_uri")).toBe("https://app.petroglyph.dev/callback");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("maps a bad code (invalid_grant) to grant-invalid", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ error: "invalid_grant" }, 400));

    const outcome = await exchangeCodeForTokens({
      clientId: "client-1",
      clientSecret: "secret-1",
      redirectUri: "https://app.petroglyph.dev/callback",
      code: "bad-code",
      fetchFn,
    });

    expect(outcome).toEqual({ kind: "grant-invalid" });
  });
});

describe("storeInitialTokens", () => {
  it("writes reconnectRequired:false via a blind (CAS expected:undefined) write", async () => {
    const write = vi.fn().mockResolvedValue(true);
    const store = { write } as unknown as TokenStore;

    await storeInitialTokens({
      store,
      userId: "github|12345",
      provider: "onedrive",
      outcome: {
        kind: "success",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresIn: 3600,
      },
    });

    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0] as [string, string, { [key: string]: unknown }, undefined];
    expect(call[0]).toBe("github|12345");
    expect(call[1]).toBe("onedrive");
    expect(call[2]).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      reconnectRequired: false,
    });
    expect(call[3]).toBeUndefined();
  });

  it("writes nothing when the grant is invalid", async () => {
    const write = vi.fn();
    const store = { write } as unknown as TokenStore;

    await storeInitialTokens({
      store,
      userId: "github|12345",
      provider: "onedrive",
      outcome: { kind: "grant-invalid" },
    });

    expect(write).not.toHaveBeenCalled();
  });
});

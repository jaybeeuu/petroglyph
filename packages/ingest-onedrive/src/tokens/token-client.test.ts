import { describe, expect, it, vi } from "vitest";
import { createTokenClient } from "./token-client.js";

const okResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createTokenClient", () => {
  const options = { clientId: "client-1", clientSecret: "secret-1" };

  it("parses a valid token response into a success outcome and posts the refresh-token form", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({
        access_token: "access-1",
        refresh_token: "refresh-2",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    const refresh = createTokenClient({ ...options, fetchFn });

    const outcome = await refresh("refresh-1");

    expect(outcome).toEqual({
      kind: "success",
      accessToken: "access-1",
      refreshToken: "refresh-2",
      expiresIn: 3600,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [
      string,
      { method: string; headers: { [key: string]: string }; body: string },
    ];
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-1");
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("scope")).toBe("files.readwrite offline_access");
  });

  it("maps invalid_grant to grant-invalid", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        okResponse({ error: "invalid_grant", error_description: "AADSTS700082" }, 400),
      );
    const refresh = createTokenClient({ ...options, fetchFn });

    await expect(refresh("refresh-1")).resolves.toEqual({ kind: "grant-invalid" });
  });

  it("throws for other non-2xx responses", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ error: "server_error" }, 502));
    const refresh = createTokenClient({ ...options, fetchFn });

    await expect(refresh("refresh-1")).rejects.toThrow();
  });

  it("rejects a malformed success body via zod", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        okResponse({ access_token: "access-1" /* missing refresh_token/expires_in */ }),
      );
    const refresh = createTokenClient({ ...options, fetchFn });

    await expect(refresh("refresh-1")).rejects.toThrow();
  });

  it("rejects a non-JSON body on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    const refresh = createTokenClient({ ...options, fetchFn });

    await expect(refresh("refresh-1")).rejects.toThrow();
  });
});

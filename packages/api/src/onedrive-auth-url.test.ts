import { createHash } from "node:crypto";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("./db.js", () => ({
  docClient: { send: mockSend },
}));

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

describe("GET /onedrive/auth-url", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-ms-client-id");
    vi.stubEnv("MICROSOFT_REDIRECT_URI", "obsidian://petroglyph/onedrive/callback");
    mockSend.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetKeyCache();
  });

  async function makeToken(): Promise<string> {
    return new SignJWT({ username: "testuser" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  async function getAuthUrl(): Promise<Response> {
    const token = await makeToken();
    return app.request("/onedrive/auth-url", {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("returns 200 with a url field", async () => {
    const res = await getAuthUrl();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(typeof body.url).toBe("string");
  });

  it("URL has correct base path, client_id, response_type, scope, and code_challenge_method=S256", async () => {
    const res = await getAuthUrl();
    const body = (await res.json()) as { url: string };
    const url = new URL(body.url);

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("test-ms-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("obsidian://petroglyph/onedrive/callback");
    expect(url.searchParams.get("scope")).toBe("files.readwrite offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("state is stored in DynamoDB with verifier, type=onedrive_state, and TTL ~10 minutes", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await getAuthUrl();
    const after = Math.floor(Date.now() / 1000);
    const body = (await res.json()) as { url: string };
    const state = new URL(body.url).searchParams.get("state");

    expect(mockSend).toHaveBeenCalledOnce();
    const [command] = mockSend.mock.calls[0] as [
      {
        input: {
          TableName: string;
          Item: { tokenHash: string; type: string; verifier: string; ttl: number };
        };
      },
    ];
    expect(command.input).toMatchObject({
      TableName: "petroglyph-refresh_tokens-default",
      Item: {
        tokenHash: state,
        type: "onedrive_state",
      },
    });
    expect(typeof command.input.Item.verifier).toBe("string");
    expect(command.input.Item.verifier.length).toBeGreaterThanOrEqual(43);
    expect(command.input.Item.ttl).toBeGreaterThanOrEqual(before + 600);
    expect(command.input.Item.ttl).toBeLessThanOrEqual(after + 600);
  });

  it("code_challenge is base64url(SHA-256(verifier))", async () => {
    const res = await getAuthUrl();
    const body = (await res.json()) as { url: string };
    const url = new URL(body.url);
    const challenge = url.searchParams.get("code_challenge");

    const [command] = mockSend.mock.calls[0] as [{ input: { Item: { verifier: string } } }];
    const { verifier } = command.input.Item;

    const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");

    expect(challenge).toBe(expectedChallenge);
  });

  it("two calls produce distinct state tokens", async () => {
    const res1 = await getAuthUrl();
    const res2 = await getAuthUrl();
    const body1 = (await res1.json()) as { url: string };
    const body2 = (await res2.json()) as { url: string };
    const state1 = new URL(body1.url).searchParams.get("state");
    const state2 = new URL(body2.url).searchParams.get("state");
    expect(state1).not.toBe(state2);
  });

  it("returns 500 when MICROSOFT_CLIENT_ID is not set", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "");
    const res = await getAuthUrl();
    expect(res.status).toBe(500);
  });

  it("returns 500 when MICROSOFT_REDIRECT_URI is not set", async () => {
    vi.stubEnv("MICROSOFT_REDIRECT_URI", "");
    const res = await getAuthUrl();
    expect(res.status).toBe(500);
  });

  it("returns 401 when no JWT is provided", async () => {
    const res = await app.request("/onedrive/auth-url");
    expect(res.status).toBe(401);
  });

  describe("harnessCallbackUri", () => {
    async function getAuthUrlWithHarness(callbackUri: string): Promise<Response> {
      const token = await makeToken();
      return app.request(
        `/onedrive/auth-url?harnessCallbackUri=${encodeURIComponent(callbackUri)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    }

    it("encodes callbackUri into the state param as {uuid}|{base64url(uri)}", async () => {
      const callbackUri = "http://127.0.0.1:8787/onedrive-callback";
      const res = await getAuthUrlWithHarness(callbackUri);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      const rawState = new URL(body.url).searchParams.get("state");
      expect(rawState).toBeTruthy();
      const parts = (rawState ?? "").split("|");
      expect(parts[1]).toBeTruthy();
      expect(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")).toBe(callbackUri);
    });

    it("stores DynamoDB item with tokenHash equal to the UUID portion only (not full state)", async () => {
      const callbackUri = "http://127.0.0.1:8787/onedrive-callback";
      const res = await getAuthUrlWithHarness(callbackUri);
      const body = (await res.json()) as { url: string };
      const rawState = new URL(body.url).searchParams.get("state") ?? "";
      const [uuid] = rawState.split("|");

      const [command] = mockSend.mock.calls[0] as [{ input: { Item: { tokenHash: string } } }];
      expect(command.input.Item.tokenHash).toBe(uuid);
      expect(command.input.Item.tokenHash).not.toBe(rawState);
    });

    it("returns 400 when harnessCallbackUri is not a localhost URL", async () => {
      const res = await getAuthUrlWithHarness("https://evil.example.com/callback");
      expect(res.status).toBe(400);
    });

    it("returns 400 when harnessCallbackUri is not a valid URL", async () => {
      const token = await makeToken();
      const res = await app.request("/onedrive/auth-url?harnessCallbackUri=not-a-url", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    });
  });
});

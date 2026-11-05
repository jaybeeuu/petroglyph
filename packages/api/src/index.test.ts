import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { SSMClient } from "@aws-sdk/client-ssm";
import type { LambdaEvent } from "hono/aws-lambda";
import type { createApp } from "./app.js";

const ssm = vi.hoisted(() => ({ clients: 0, sends: 0, failNextSends: 0 }));
const app = vi.hoisted(() => ({ created: 0 }));

vi.mock("@aws-sdk/client-ssm", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, {
    SSMClient: class {
      constructor() {
        ssm.clients += 1;
      }

      send = (): Promise<{ Parameters: { Name?: string; Value?: string }[] }> => {
        ssm.sends += 1;
        if (ssm.failNextSends > 0) {
          ssm.failNextSends -= 1;
          return Promise.reject(new Error("Throttled"));
        }
        return Promise.resolve({ Parameters: [] });
      };
    },
  });
});

vi.mock("./app.js", async (importOriginal) => {
  const actual = await importOriginal<{ createApp: typeof createApp }>();
  return {
    ...actual,
    createApp: () => {
      app.created += 1;
      return actual.createApp();
    },
  };
});

import { loadSSMParameters, SSM_MAPPINGS, type handler as lambdaHandler } from "./index.js";

/** The API Gateway v2 shape Hono's aws-lambda adapter consumes. */
type ApiGatewayV2Event = Extract<LambdaEvent, { rawPath: string }>;

function healthEvent(): ApiGatewayV2Event {
  return {
    version: "2.0",
    routeKey: "GET /health",
    rawPath: "/health",
    rawQueryString: "",
    headers: { host: "test.execute-api.eu-west-2.amazonaws.com" },
    requestContext: {
      accountId: "000000000000",
      apiId: "test",
      authentication: null,
      authorizer: {},
      domainName: "test.execute-api.eu-west-2.amazonaws.com",
      domainPrefix: "test",
      http: {
        method: "GET",
        path: "/health",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "request-1",
      routeKey: "GET /health",
      stage: "$default",
      time: "2026-09-01T00:00:00.000Z",
      timeEpoch: 1756684800000,
    },
    isBase64Encoded: false,
    body: null,
  };
}

/**
 * Each handler test needs its own instance of the module, because the module
 * caches its initialisation. Re-evaluating it gives a fresh cache.
 */
async function loadHandler(): Promise<typeof lambdaHandler> {
  vi.resetModules();
  const { handler } = await import("./index.js");
  return handler;
}

describe("handler cold start", () => {
  beforeEach(() => {
    ssm.clients = 0;
    ssm.sends = 0;
    ssm.failNextSends = 0;
    app.created = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads the SSM parameters on first invocation, not at import", async () => {
    const handler = await loadHandler();
    expect(ssm.clients).toBe(0);
    expect(ssm.sends).toBe(0);

    vi.stubEnv("GITHUB_CLIENT_ID_SSM_PATH", "/petroglyph/production/github/client-id");

    const first = await handler(healthEvent());
    const second = await handler(healthEvent());

    expect(first).toMatchObject({ statusCode: 200 });
    expect(second).toMatchObject({ statusCode: 200 });
    expect(ssm.clients).toBe(1);
    expect(ssm.sends).toBe(1);
    expect(app.created).toBe(1);
  });

  it("retries initialisation on the next invocation when the SSM load rejects", async () => {
    const handler = await loadHandler();

    vi.stubEnv("GITHUB_CLIENT_ID_SSM_PATH", "/petroglyph/production/github/client-id");
    ssm.failNextSends = 1;

    await expect(handler(healthEvent())).rejects.toThrow("Throttled");
    const second = await handler(healthEvent());

    expect(second).toMatchObject({ statusCode: 200 });
    expect(ssm.sends).toBe(2);
  });

  it("shares one SSM load and one route graph between concurrent invocations", async () => {
    const handler = await loadHandler();

    vi.stubEnv("GITHUB_CLIENT_ID_SSM_PATH", "/petroglyph/production/github/client-id");

    const [first, second] = await Promise.all([handler(healthEvent()), handler(healthEvent())]);

    expect(first).toMatchObject({ statusCode: 200 });
    expect(second).toMatchObject({ statusCode: 200 });
    expect(ssm.sends).toBe(1);
    expect(app.created).toBe(1);
  });
});

describe("loadSSMParameters", () => {
  it("does not call SSM when no path env vars are set", async () => {
    const mockSend = vi.fn();
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;
    const env = {};

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("calls SSM with correct parameter names when path env vars are set", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [
        { Name: "/petroglyph/production/github/client-id", Value: "test-client-id" },
        { Name: "/petroglyph/production/github/client-secret", Value: "test-client-secret" },
      ],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/production/github/client-id",
      GITHUB_CLIENT_SECRET_SSM_PATH: "/petroglyph/production/github/client-secret",
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(mockSend).toHaveBeenCalledOnce();
    const calls = mockSend.mock.calls as Array<
      [{ input: { Names: string[]; WithDecryption: boolean } }]
    >;
    const command = calls[0]?.[0];
    assert(command !== undefined);
    expect(command.input.Names).toEqual([
      "/petroglyph/production/github/client-id",
      "/petroglyph/production/github/client-secret",
    ]);
    expect(command.input.WithDecryption).toBe(true);
  });

  it("writes SSM values to target env vars", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [
        { Name: "/petroglyph/production/github/client-id", Value: "test-client-id" },
        { Name: "/petroglyph/production/github/client-secret", Value: "test-client-secret" },
      ],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env: { [key: string]: string } = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/production/github/client-id",
      GITHUB_CLIENT_SECRET_SSM_PATH: "/petroglyph/production/github/client-secret",
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(env["GITHUB_CLIENT_ID"]).toBe("test-client-id");
    expect(env["GITHUB_CLIENT_SECRET"]).toBe("test-client-secret");
  });

  it("handles partial mappings (some SSM paths set, some not)", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [{ Name: "/petroglyph/production/github/client-id", Value: "test-client-id" }],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env: { [key: string]: string } = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/production/github/client-id",
      // GITHUB_CLIENT_SECRET_SSM_PATH is NOT set
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(env["GITHUB_CLIENT_ID"]).toBe("test-client-id");
    expect(env["GITHUB_CLIENT_SECRET"]).toBeUndefined();
  });

  it("handles SSM response missing some parameters", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [
        // Only one parameter returned, even though two were requested
        { Name: "/petroglyph/production/github/client-id", Value: "test-client-id" },
      ],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env: { [key: string]: string } = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/production/github/client-id",
      GITHUB_CLIENT_SECRET_SSM_PATH: "/petroglyph/production/github/client-secret",
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(env["GITHUB_CLIENT_ID"]).toBe("test-client-id");
    expect(env["GITHUB_CLIENT_SECRET"]).toBeUndefined();
  });

  it("does not overwrite existing target env vars when SSM returns no value", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [
        { Name: "/petroglyph/production/github/client-id", Value: undefined }, // No value
      ],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env: { [key: string]: string | undefined } = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/production/github/client-id",
      GITHUB_CLIENT_ID: "existing-value",
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(env["GITHUB_CLIENT_ID"]).toBe("existing-value");
  });

  it("maps all expected SSM paths to target env vars", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [
        { Name: "/petroglyph/production/github/client-id", Value: "github-id" },
        { Name: "/petroglyph/production/github/client-secret", Value: "github-secret" },
        { Name: "/petroglyph/production/jwt/private-key", Value: "jwt-private" },
        { Name: "/petroglyph/production/jwt/public-key", Value: "jwt-public" },
        { Name: "/petroglyph/production/onedrive/client-id", Value: "onedrive-id" },
        { Name: "/petroglyph/production/onedrive/client-secret", Value: "onedrive-secret" },
      ],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env: { [key: string]: string } = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/production/github/client-id",
      GITHUB_CLIENT_SECRET_SSM_PATH: "/petroglyph/production/github/client-secret",
      JWT_PRIVATE_KEY_SSM_PATH: "/petroglyph/production/jwt/private-key",
      JWT_PUBLIC_KEY_SSM_PATH: "/petroglyph/production/jwt/public-key",
      ONEDRIVE_CLIENT_ID_SSM_PATH: "/petroglyph/production/onedrive/client-id",
      ONEDRIVE_CLIENT_SECRET_SSM_PATH: "/petroglyph/production/onedrive/client-secret",
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(env["GITHUB_CLIENT_ID"]).toBe("github-id");
    expect(env["GITHUB_CLIENT_SECRET"]).toBe("github-secret");
    expect(env["JWT_PRIVATE_KEY"]).toBe("jwt-private");
    expect(env["JWT_PUBLIC_KEY"]).toBe("jwt-public");
    expect(env["MICROSOFT_CLIENT_ID"]).toBe("onedrive-id"); // Note: ONEDRIVE maps to MICROSOFT
    expect(env["MICROSOFT_CLIENT_SECRET"]).toBe("onedrive-secret"); // Note: ONEDRIVE maps to MICROSOFT
  });
});

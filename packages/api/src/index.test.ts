import { assert, describe, expect, it, vi } from "vitest";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { loadSSMParameters, SSM_MAPPINGS } from "./index.js";

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

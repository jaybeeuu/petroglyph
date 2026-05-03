import { describe, expect, it, vi } from "vitest";
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
        { Name: "/petroglyph/github/client-id", Value: "test-client-id" },
        { Name: "/petroglyph/jwt/signing-secret", Value: "test-secret" },
      ],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/github/client-id",
      JWT_SIGNING_SECRET_SSM_PATH: "/petroglyph/jwt/signing-secret",
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(mockSend).toHaveBeenCalledOnce();
    const calls = mockSend.mock.calls as Array<
      [{ input: { Names: string[]; WithDecryption: boolean } }]
    >;
    const command = calls[0]?.[0];
    expect(command.input.Names).toEqual([
      "/petroglyph/github/client-id",
      "/petroglyph/jwt/signing-secret",
    ]);
    expect(command.input.WithDecryption).toBe(true);
  });

  it("writes SSM values to target env vars", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [
        { Name: "/petroglyph/github/client-id", Value: "test-client-id" },
        { Name: "/petroglyph/jwt/signing-secret", Value: "test-secret" },
      ],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env: { [key: string]: string } = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/github/client-id",
      JWT_SIGNING_SECRET_SSM_PATH: "/petroglyph/jwt/signing-secret",
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(env["GITHUB_CLIENT_ID"]).toBe("test-client-id");
    expect(env["JWT_SIGNING_SECRET"]).toBe("test-secret");
  });

  it("handles partial mappings (some SSM paths set, some not)", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [{ Name: "/petroglyph/github/client-id", Value: "test-client-id" }],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env: { [key: string]: string } = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/github/client-id",
      // JWT_SIGNING_SECRET_SSM_PATH is NOT set
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(env["GITHUB_CLIENT_ID"]).toBe("test-client-id");
    expect(env["JWT_SIGNING_SECRET"]).toBeUndefined();
  });

  it("handles SSM response missing some parameters", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [
        // Only one parameter returned, even though two were requested
        { Name: "/petroglyph/github/client-id", Value: "test-client-id" },
      ],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env: { [key: string]: string } = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/github/client-id",
      JWT_SIGNING_SECRET_SSM_PATH: "/petroglyph/jwt/signing-secret",
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(env["GITHUB_CLIENT_ID"]).toBe("test-client-id");
    expect(env["JWT_SIGNING_SECRET"]).toBeUndefined();
  });

  it("does not overwrite existing target env vars when SSM returns no value", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [
        { Name: "/petroglyph/github/client-id", Value: undefined }, // No value
      ],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env: { [key: string]: string | undefined } = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/github/client-id",
      GITHUB_CLIENT_ID: "existing-value",
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(env["GITHUB_CLIENT_ID"]).toBe("existing-value");
  });

  it("maps all expected SSM paths to target env vars", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Parameters: [
        { Name: "/petroglyph/github/client-id", Value: "github-id" },
        { Name: "/petroglyph/github/client-secret", Value: "github-secret" },
        { Name: "/petroglyph/jwt/signing-secret", Value: "jwt-secret" },
        { Name: "/petroglyph/jwt/private-key", Value: "jwt-private" },
        { Name: "/petroglyph/jwt/public-key", Value: "jwt-public" },
        { Name: "/petroglyph/onedrive/client-id", Value: "onedrive-id" },
      ],
    });
    const mockClient = {
      send: mockSend,
    } as unknown as SSMClient;

    const env: { [key: string]: string } = {
      GITHUB_CLIENT_ID_SSM_PATH: "/petroglyph/github/client-id",
      GITHUB_CLIENT_SECRET_SSM_PATH: "/petroglyph/github/client-secret",
      JWT_SIGNING_SECRET_SSM_PATH: "/petroglyph/jwt/signing-secret",
      JWT_PRIVATE_KEY_SSM_PATH: "/petroglyph/jwt/private-key",
      JWT_PUBLIC_KEY_SSM_PATH: "/petroglyph/jwt/public-key",
      ONEDRIVE_CLIENT_ID_SSM_PATH: "/petroglyph/onedrive/client-id",
    };

    await loadSSMParameters(mockClient, SSM_MAPPINGS, env);

    expect(env["GITHUB_CLIENT_ID"]).toBe("github-id");
    expect(env["GITHUB_CLIENT_SECRET"]).toBe("github-secret");
    expect(env["JWT_SIGNING_SECRET"]).toBe("jwt-secret");
    expect(env["JWT_PRIVATE_KEY"]).toBe("jwt-private");
    expect(env["JWT_PUBLIC_KEY"]).toBe("jwt-public");
    expect(env["MICROSOFT_CLIENT_ID"]).toBe("onedrive-id"); // Note: ONEDRIVE maps to MICROSOFT
  });
});

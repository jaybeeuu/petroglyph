import { PutParameterCommand } from "@aws-sdk/client-ssm";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());
const mockSsmSend = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

vi.mock("./ssm.js", () => ({
  ssmClient: { send: mockSsmSend },
}));

vi.stubGlobal("fetch", mockFetch);

import { app } from "./app.js";

describe("POST /onedrive/lifecycle", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockDbSend.mockReset();
    mockSsmSend.mockReset();
    mockFetch.mockReset();
    vi.stubEnv("USERS_TABLE", "petroglyph-users-test");
    vi.stubEnv("REFRESH_TOKENS_TABLE", "petroglyph-refresh_tokens-test");
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-ms-client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-ms-client-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  interface CommandResponseEntry {
    command: new (...args: never[]) => object;
    response: unknown;
  }

  function setupDbMock(entries: CommandResponseEntry[]): void {
    mockDbSend.mockImplementation((command: unknown) => {
      const match = entries.find((entry) => command instanceof entry.command);
      return Promise.resolve(match?.response ?? {});
    });
  }

  function setupSsmMock(entries: CommandResponseEntry[]): void {
    mockSsmSend.mockImplementation((command: unknown) => {
      const match = entries.find((entry) => command instanceof entry.command);
      return Promise.resolve(match?.response ?? {});
    });
  }

  function updateCalls(): Array<[unknown]> {
    return mockDbSend.mock.calls.filter(([command]) => command instanceof UpdateCommand) as Array<
      [unknown]
    >;
  }

  function putParameterCalls(): Array<[unknown]> {
    return mockSsmSend.mock.calls.filter(
      ([command]) => command instanceof PutParameterCommand,
    ) as Array<[unknown]>;
  }

  it("returns the Microsoft validation token as plain text", async () => {
    const response = await app.request("/onedrive/lifecycle?validationToken=handshake-token", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("handshake-token");
  });

  it("marks the user as reconnect_required for subscriptionRemoved events", async () => {
    const response = await app.request("/onedrive/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: [
          {
            lifecycleEvent: "subscriptionRemoved",
            clientState: "user-123",
            subscriptionId: "sub-123",
          },
        ],
      }),
    });

    expect(response.status).toBe(202);

    await vi.waitFor(() => {
      expect(updateCalls()).toHaveLength(1);
    });

    const updateCall = updateCalls()[0];
    if (!updateCall) {
      throw new Error("Expected one UpdateCommand call");
    }

    const [updateCommand] = updateCall as [
      {
        input: {
          TableName: string;
          Key: { userId: string };
          ExpressionAttributeValues: { [key: string]: unknown };
        };
      },
    ];
    expect(updateCommand.input.TableName).toBe("petroglyph-users-test");
    expect(updateCommand.input.Key).toEqual({ userId: "user-123" });
    expect(updateCommand.input.ExpressionAttributeValues[":status"]).toBe("reconnect_required");
  });

  it("refreshes the token and renews the subscription for reauthorizationRequired events", async () => {
    setupDbMock([
      { command: GetCommand, response: { Item: { refreshToken: "existing-refresh-token" } } },
    ]);
    setupSsmMock([{ command: PutParameterCommand, response: {} }]);
    mockFetch.mockImplementation((url: string) => {
      if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 3600,
            }),
        } as Response);
      }
      if (url === "https://graph.microsoft.com/v1.0/subscriptions/sub-123") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "sub-123",
              expirationDateTime: "2026-04-14T00:00:00.000Z",
            }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const response = await app.request("/onedrive/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: [
          {
            lifecycleEvent: "reauthorizationRequired",
            clientState: "user-123",
            subscriptionId: "sub-123",
          },
        ],
      }),
    });

    expect(response.status).toBe(202);

    await vi.waitFor(() => {
      const call = mockFetch.mock.calls.find(
        ([url]) => url === "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      );
      expect(call).toBeDefined();
      return call;
    });

    const renewCall = await vi.waitFor(() => {
      const call = mockFetch.mock.calls.find(
        ([url]) => url === "https://graph.microsoft.com/v1.0/subscriptions/sub-123",
      );
      expect(call).toBeDefined();
      return call;
    });

    const [, renewOptions] = renewCall as [string, RequestInit];
    expect(renewOptions.method).toBe("PATCH");
    expect((renewOptions.headers as { [key: string]: string })["Authorization"]).toBe(
      "Bearer new-access-token",
    );

    await vi.waitFor(() => {
      expect(updateCalls()).toHaveLength(1);
      expect(
        putParameterCalls().some(
          ([command]) =>
            (command as { input: { Name: string } }).input.Name ===
            "/petroglyph/onedrive/subscription-expiry",
        ),
      ).toBe(true);
    });

    const parameterNames = putParameterCalls().map(
      ([command]) => (command as { input: { Name: string } }).input.Name,
    );
    expect(parameterNames).toContain("/petroglyph/onedrive/subscription-expiry");

    const updateCall = updateCalls()[0];
    if (!updateCall) {
      throw new Error("Expected one UpdateCommand call");
    }

    const [updateCommand] = updateCall as [
      {
        input: {
          Key: { userId: string };
          ExpressionAttributeValues: { [key: string]: unknown };
        };
      },
    ];
    expect(updateCommand.input.Key).toEqual({ userId: "user-123" });
    expect(updateCommand.input.ExpressionAttributeValues[":status"]).toBe("connected");
  });

  it("marks the user as reconnect_required when token refresh fails", async () => {
    setupDbMock([
      { command: GetCommand, response: { Item: { refreshToken: "existing-refresh-token" } } },
    ]);
    setupSsmMock([{ command: PutParameterCommand, response: {} }]);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: () => Promise.resolve({ error: "invalid_grant" }),
    } as Response);

    const response = await app.request("/onedrive/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: [
          {
            lifecycleEvent: "reauthorizationRequired",
            clientState: "user-123",
            subscriptionId: "sub-123",
          },
        ],
      }),
    });

    expect(response.status).toBe(202);

    await vi.waitFor(() => {
      expect(updateCalls()).toHaveLength(1);
    });

    const updateCall = updateCalls()[0];
    if (!updateCall) {
      throw new Error("Expected one UpdateCommand call");
    }

    const [updateCommand] = updateCall as [
      {
        input: {
          Key: { userId: string };
          ExpressionAttributeValues: { [key: string]: unknown };
        };
      },
    ];
    expect(updateCommand.input.Key).toEqual({ userId: "user-123" });
    expect(updateCommand.input.ExpressionAttributeValues[":status"]).toBe("reconnect_required");
  });

  it("marks the user as reconnect_required when subscription renewal fails", async () => {
    setupDbMock([
      { command: GetCommand, response: { Item: { refreshToken: "existing-refresh-token" } } },
    ]);
    setupSsmMock([{ command: PutParameterCommand, response: {} }]);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({}),
    } as Response);

    const response = await app.request("/onedrive/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: [
          {
            lifecycleEvent: "reauthorizationRequired",
            clientState: "user-456",
            subscriptionId: "sub-456",
          },
        ],
      }),
    });

    expect(response.status).toBe(202);

    await vi.waitFor(() => {
      expect(updateCalls()).toHaveLength(1);
    });

    const updateCall = updateCalls()[0];
    if (!updateCall) {
      throw new Error("Expected one UpdateCommand call");
    }

    const [updateCommand] = updateCall as [
      {
        input: {
          Key: { userId: string };
          ExpressionAttributeValues: { [key: string]: unknown };
        };
      },
    ];
    expect(updateCommand.input.Key).toEqual({ userId: "user-456" });
    expect(updateCommand.input.ExpressionAttributeValues[":status"]).toBe("reconnect_required");
  });

  it("returns 202 after subscriptionRemoved work finishes", async () => {
    mockDbSend.mockResolvedValue({});

    const response = await app.request("/onedrive/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: [
          {
            lifecycleEvent: "subscriptionRemoved",
            clientState: "user-789",
          },
        ],
      }),
    });

    expect(response.status).toBe(202);
    expect(updateCalls()).toHaveLength(1);
  });

  it("returns 202 after reauthorization work finishes", async () => {
    setupDbMock([
      { command: GetCommand, response: { Item: { refreshToken: "existing-refresh-token" } } },
    ]);
    setupSsmMock([{ command: PutParameterCommand, response: {} }]);
    mockFetch.mockImplementation((url: string) => {
      if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 3600,
            }),
        } as Response);
      }
      if (url === "https://graph.microsoft.com/v1.0/subscriptions/sub-123") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "sub-123",
              expirationDateTime: "2026-04-14T00:00:00.000Z",
            }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const response = await app.request("/onedrive/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: [
          {
            lifecycleEvent: "reauthorizationRequired",
            clientState: "user-123",
            subscriptionId: "sub-123",
          },
        ],
      }),
    });

    expect(response.status).toBe(202);
    expect(updateCalls()).toHaveLength(1);
    expect(
      putParameterCalls().some(
        ([command]) =>
          (command as { input: { Name: string } }).input.Name ===
          "/petroglyph/onedrive/subscription-expiry",
      ),
    ).toBe(true);
  });

  it("returns 202 after lifecycle processing succeeds", async () => {
    const response = await app.request("/onedrive/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: [
          {
            lifecycleEvent: "subscriptionRemoved",
            clientState: "user-789",
          },
        ],
      }),
    });

    expect(response.status).toBe(202);

    await vi.waitFor(() => {
      expect(updateCalls()).toHaveLength(1);
    });
  });
});

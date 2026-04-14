import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-ms-client-id");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function setupSsmMock(tokenExpiry: string): void {
    mockSsmSend.mockImplementation((command: unknown) => {
      if (command instanceof GetParameterCommand) {
        const name = (command as { input: { Name: string } }).input.Name;
        if (name === "/petroglyph/onedrive/access-token") {
          return Promise.resolve({ Parameter: { Value: "existing-access-token" } });
        }
        if (name === "/petroglyph/onedrive/token-expiry") {
          return Promise.resolve({ Parameter: { Value: tokenExpiry } });
        }
        if (name === "/petroglyph/onedrive/refresh-token") {
          return Promise.resolve({ Parameter: { Value: "existing-refresh-token" } });
        }
      }
      if (command instanceof PutParameterCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
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

  it("refreshes and renews subscriptions for reauthorizationRequired events", async () => {
    setupSsmMock(new Date(Date.now() + 5 * 60 * 1000).toISOString());
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
    setupSsmMock(new Date(Date.now() + 5 * 60 * 1000).toISOString());
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
    setupSsmMock(new Date(Date.now() + 30 * 60 * 1000).toISOString());
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

  it("returns 202 before subscriptionRemoved work finishes", async () => {
    let resolveUpdate: (() => void) | undefined;
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof UpdateCommand) {
        return new Promise((resolve) => {
          resolveUpdate = () => {
            resolve({});
          };
        });
      }

      return Promise.resolve({});
    });

    const requestPromise: Promise<Response> = Promise.resolve(
      app.request("/onedrive/lifecycle", {
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
      }),
    );

    const response = await Promise.race([
      requestPromise.then(() => "response" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => {
          resolve("timeout");
        }, 20);
      }),
    ]);

    expect(response).toBe("response");
    await vi.waitFor(() => {
      expect(resolveUpdate).toBeTypeOf("function");
    });
    resolveUpdate?.();

    const completedResponse = await requestPromise;
    expect(completedResponse.status).toBe(202);

    await vi.waitFor(() => {
      expect(updateCalls()).toHaveLength(1);
    });
  });

  it("returns 202 before reauthorization work finishes", async () => {
    setupSsmMock(new Date(Date.now() + 5 * 60 * 1000).toISOString());
    let resolveRenewal: (() => void) | undefined;
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
        return new Promise((resolve) => {
          resolveRenewal = () => {
            resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  id: "sub-123",
                  expirationDateTime: "2026-04-14T00:00:00.000Z",
                }),
            } as Response);
          };
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const requestPromise: Promise<Response> = Promise.resolve(
      app.request("/onedrive/lifecycle", {
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
      }),
    );

    const response = await Promise.race([
      requestPromise.then(() => "response" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => {
          resolve("timeout");
        }, 20);
      }),
    ]);

    expect(response).toBe("response");
    await vi.waitFor(() => {
      expect(resolveRenewal).toBeTypeOf("function");
    });
    resolveRenewal?.();

    const completedResponse = await requestPromise;
    expect(completedResponse.status).toBe(202);

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

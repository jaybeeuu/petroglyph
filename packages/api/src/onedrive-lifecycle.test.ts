import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: () => ({ send: mockDbSend }),
}));

vi.stubGlobal("fetch", mockFetch);

import { createApp } from "./app.js";

const app = createApp();

describe("POST /onedrive/lifecycle", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockDbSend.mockReset();
    mockFetch.mockReset();
    vi.stubEnv("USERS_TABLE", "petroglyph-users-test");
    vi.stubEnv("REFRESH_TOKENS_TABLE", "petroglyph-refresh_tokens-test");
    vi.stubEnv("TOKEN_VAULTS_TABLE", "petroglyph-token-vaults-test");
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

  function updateCalls(): Array<[unknown]> {
    return mockDbSend.mock.calls.filter(([command]) => command instanceof UpdateCommand) as Array<
      [unknown]
    >;
  }

  /** The `input` of every UpdateCommand issued against one table. */
  function updateCallsForTable(tableName: string): Array<{ [key: string]: unknown }> {
    return updateCalls()
      .map(
        ([command]) =>
          (command as { input: { TableName?: string } & { [key: string]: unknown } }).input,
      )
      .filter((input) => input["TableName"] === tableName);
  }

  /** The stored connection row the lifecycle path refreshes, as the vault holds it. */
  function vaultItem(): { [key: string]: unknown } {
    return {
      userId: "user-123",
      provider: "onedrive",
      accessToken: "expired-access-token",
      refreshToken: "old-refresh-token",
      expirySeconds: 1_000_000,
      updatedAt: "2026-09-01T00:00:00.000Z",
      reconnectRequired: false,
    };
  }

  function usersStatusUpdate():
    | {
        input: { TableName?: string; ExpressionAttributeValues: { [key: string]: unknown } };
      }
    | undefined {
    return updateCalls()
      .map(
        ([command]) =>
          command as {
            input: { TableName?: string; ExpressionAttributeValues: { [key: string]: unknown } };
          },
      )
      .find((command) => command.input.TableName === "petroglyph-users-test");
  }

  function setupReauthorizeFallbackFetch(options: {
    subscriptionId: string;
    deleteStatus: number;
    recreateOk: boolean;
  }): void {
    const { subscriptionId, deleteStatus, recreateOk } = options;
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
      if (url === `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}/reauthorize`) {
        return Promise.resolve({
          ok: false,
          status: 308,
          statusText: "Permanent Redirect",
        } as Response);
      }
      if (url === `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`) {
        return Promise.resolve({
          ok: deleteStatus < 400,
          status: deleteStatus,
          statusText: deleteStatus === 404 ? "Not Found" : "No Content",
        } as Response);
      }
      if (url === "https://graph.microsoft.com/v1.0/me/drive") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "drive-123" }),
        } as Response);
      }
      if (url === "https://graph.microsoft.com/v1.0/subscriptions") {
        return Promise.resolve({
          ok: recreateOk,
          status: recreateOk ? 201 : 500,
          statusText: recreateOk ? "Created" : "Internal Server Error",
          json: () => Promise.resolve({ id: "sub-recreated" }),
          text: () => Promise.resolve('{"error":"subscription creation failed"}'),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
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

  it("refreshes the token and reauthorizes the subscription for reauthorizationRequired events", async () => {
    setupDbMock([{ command: GetCommand, response: { Item: vaultItem() } }]);
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
      if (url === "https://graph.microsoft.com/v1.0/subscriptions/sub-123/reauthorize") {
        return Promise.resolve({
          ok: true,
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
        ([url]) => url === "https://graph.microsoft.com/v1.0/subscriptions/sub-123/reauthorize",
      );
      expect(call).toBeDefined();
      return call;
    });

    const [, renewOptions] = renewCall as [string, RequestInit];
    expect(renewOptions.method).toBe("POST");
    expect((renewOptions.headers as { [key: string]: string })["Authorization"]).toBe(
      "Bearer new-access-token",
    );

    await vi.waitFor(() => {
      expect(updateCalls()).toHaveLength(2);
    });

    const [vaultUpdate] = updateCallsForTable("petroglyph-token-vaults-test") as [
      {
        Key: { userId: string; provider: string };
        ConditionExpression?: string;
        ExpressionAttributeValues: { [key: string]: unknown };
      },
    ];
    expect(vaultUpdate.Key).toEqual({ userId: "user-123", provider: "onedrive" });
    expect(vaultUpdate.ConditionExpression).toContain("updatedAt = :expectedUpdatedAt");
    expect(vaultUpdate.ExpressionAttributeValues).toMatchObject({
      ":accessToken": "new-access-token",
      ":refreshToken": "new-refresh-token",
      ":expectedUpdatedAt": "2026-09-01T00:00:00.000Z",
      ":reconnectRequired": false,
    });

    const [statusUpdate] = updateCallsForTable("petroglyph-users-test") as [
      {
        Key: { userId: string };
        ExpressionAttributeValues: { [key: string]: unknown };
      },
    ];
    expect(statusUpdate.Key).toEqual({ userId: "user-123" });
    expect(statusUpdate.ExpressionAttributeValues[":status"]).toBe("connected");
  });

  it("writes no rotated token to the legacy refresh_tokens table", async () => {
    setupDbMock([{ command: GetCommand, response: { Item: vaultItem() } }]);
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
      return Promise.resolve({ ok: true } as Response);
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
      expect(updateCalls()).toHaveLength(2);
    });

    expect(updateCallsForTable("petroglyph-refresh_tokens-test")).toHaveLength(0);
  });

  it("marks the user as reconnect_required when token refresh fails", async () => {
    setupDbMock([{ command: GetCommand, response: { Item: vaultItem() } }]);
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
      expect(updateCallsForTable("petroglyph-users-test")).toHaveLength(1);
    });

    const [vaultUpdate] = updateCallsForTable("petroglyph-token-vaults-test") as [
      { ExpressionAttributeValues: { [key: string]: unknown } },
    ];
    expect(vaultUpdate.ExpressionAttributeValues[":reconnectRequired"]).toBe(true);

    const [statusUpdate] = updateCallsForTable("petroglyph-users-test") as [
      {
        Key: { userId: string };
        ExpressionAttributeValues: { [key: string]: unknown };
      },
    ];
    expect(statusUpdate.Key).toEqual({ userId: "user-123" });
    expect(statusUpdate.ExpressionAttributeValues[":status"]).toBe("reconnect_required");
  });

  it("falls back to DELETE + recreate and marks connected when Graph reauthorize returns 308", async () => {
    vi.stubEnv("GRAPH_NOTIFICATION_URL", "https://api.example.com/graph/notify");
    vi.stubEnv("GRAPH_LIFECYCLE_URL", "https://api.example.com/graph/lifecycle");
    setupDbMock([{ command: GetCommand, response: { Item: vaultItem() } }]);
    setupReauthorizeFallbackFetch({
      subscriptionId: "sub-123",
      deleteStatus: 204,
      recreateOk: true,
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
      const statusUpdate = usersStatusUpdate();
      expect(statusUpdate).toBeDefined();
      expect(
        (statusUpdate?.input as { ExpressionAttributeValues: { [key: string]: unknown } })
          .ExpressionAttributeValues[":status"],
      ).toBe("connected");
    });

    const deleteCall = mockFetch.mock.calls.find(
      ([url]) => url === "https://graph.microsoft.com/v1.0/subscriptions/sub-123",
    );
    expect(deleteCall).toBeDefined();
    const [, deleteOptions] = deleteCall as [string, RequestInit];
    expect(deleteOptions.method).toBe("DELETE");
    expect((deleteOptions.headers as { [key: string]: string })["Authorization"]).toBe(
      "Bearer new-access-token",
    );

    const recreateCall = mockFetch.mock.calls.find(
      ([url]) => url === "https://graph.microsoft.com/v1.0/subscriptions",
    );
    expect(recreateCall).toBeDefined();
    const [, recreateOptions] = recreateCall as [string, RequestInit];
    expect(recreateOptions.method).toBe("POST");
    expect((recreateOptions.headers as { [key: string]: string })["Authorization"]).toBe(
      "Bearer new-access-token",
    );
  });

  it("ignores a 404 from DELETE and still recreates the subscription", async () => {
    vi.stubEnv("GRAPH_NOTIFICATION_URL", "https://api.example.com/graph/notify");
    vi.stubEnv("GRAPH_LIFECYCLE_URL", "https://api.example.com/graph/lifecycle");
    setupDbMock([{ command: GetCommand, response: { Item: vaultItem() } }]);
    setupReauthorizeFallbackFetch({
      subscriptionId: "sub-124",
      deleteStatus: 404,
      recreateOk: true,
    });

    const response = await app.request("/onedrive/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: [
          {
            lifecycleEvent: "reauthorizationRequired",
            clientState: "user-124",
            subscriptionId: "sub-124",
          },
        ],
      }),
    });

    expect(response.status).toBe(202);

    await vi.waitFor(() => {
      const statusUpdate = usersStatusUpdate();
      expect(statusUpdate).toBeDefined();
      expect(
        (statusUpdate?.input as { ExpressionAttributeValues: { [key: string]: unknown } })
          .ExpressionAttributeValues[":status"],
      ).toBe("connected");
    });

    const deleteCall = mockFetch.mock.calls.find(
      ([url]) => url === "https://graph.microsoft.com/v1.0/subscriptions/sub-124",
    );
    expect(deleteCall).toBeDefined();
    const [, deleteOptions] = deleteCall as [string, RequestInit];
    expect(deleteOptions.method).toBe("DELETE");

    const recreateCall = mockFetch.mock.calls.find(
      ([url]) => url === "https://graph.microsoft.com/v1.0/subscriptions",
    );
    expect(recreateCall).toBeDefined();
  });

  it("marks the user as reconnect_required when subscription recreate also fails", async () => {
    vi.stubEnv("GRAPH_NOTIFICATION_URL", "https://api.example.com/graph/notify");
    vi.stubEnv("GRAPH_LIFECYCLE_URL", "https://api.example.com/graph/lifecycle");
    setupDbMock([{ command: GetCommand, response: { Item: vaultItem() } }]);
    setupReauthorizeFallbackFetch({
      subscriptionId: "sub-456",
      deleteStatus: 204,
      recreateOk: false,
    });

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
      const statusUpdate = usersStatusUpdate();
      expect(statusUpdate).toBeDefined();
      expect(
        (statusUpdate?.input as { ExpressionAttributeValues: { [key: string]: unknown } })
          .ExpressionAttributeValues[":status"],
      ).toBe("reconnect_required");
    });
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
    setupDbMock([{ command: GetCommand, response: { Item: vaultItem() } }]);
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
      if (url === "https://graph.microsoft.com/v1.0/subscriptions/sub-123/reauthorize") {
        return Promise.resolve({
          ok: true,
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
    expect(updateCalls()).toHaveLength(2);
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

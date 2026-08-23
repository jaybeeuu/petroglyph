import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

vi.stubGlobal("fetch", mockFetch);

import { app } from "./app.js";

describe("POST /onedrive/lifecycle", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockDbSend.mockReset();
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

  function updateCalls(): Array<[unknown]> {
    return mockDbSend.mock.calls.filter(([command]) => command instanceof UpdateCommand) as Array<
      [unknown]
    >;
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
    setupDbMock([
      { command: GetCommand, response: { Item: { refreshToken: "existing-refresh-token" } } },
    ]);
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

    const updateCommands = updateCalls().map(([command]) => command as { input: unknown });
    const tokenUpdate = updateCommands.find(
      (command) =>
        (command.input as { TableName?: string }).TableName === "petroglyph-refresh_tokens-test",
    );
    expect(tokenUpdate).toBeDefined();
    expect((tokenUpdate?.input as { Key: { tokenHash: string } }).Key).toEqual({
      tokenHash: "user-123",
    });
    expect(
      (tokenUpdate?.input as { ExpressionAttributeValues: { [key: string]: unknown } })
        .ExpressionAttributeValues[":accessToken"],
    ).toBe("new-access-token");
    expect(
      (tokenUpdate?.input as { ExpressionAttributeValues: { [key: string]: unknown } })
        .ExpressionAttributeValues[":refreshToken"],
    ).toBe("new-refresh-token");

    const statusUpdate = updateCommands.find(
      (command) => (command.input as { TableName?: string }).TableName === "petroglyph-users-test",
    );
    expect(statusUpdate).toBeDefined();
    expect((statusUpdate?.input as { Key: { userId: string } }).Key).toEqual({
      userId: "user-123",
    });
    expect(
      (statusUpdate?.input as { ExpressionAttributeValues: { [key: string]: unknown } })
        .ExpressionAttributeValues[":status"],
    ).toBe("connected");
  });

  it("marks the user as reconnect_required when token refresh fails", async () => {
    setupDbMock([
      { command: GetCommand, response: { Item: { refreshToken: "existing-refresh-token" } } },
    ]);
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

  it("falls back to DELETE + recreate and marks connected when Graph reauthorize returns 308", async () => {
    vi.stubEnv("GRAPH_NOTIFICATION_URL", "https://api.example.com/graph/notify");
    vi.stubEnv("GRAPH_LIFECYCLE_URL", "https://api.example.com/graph/lifecycle");
    setupDbMock([
      { command: GetCommand, response: { Item: { refreshToken: "existing-refresh-token" } } },
    ]);
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
    setupDbMock([
      { command: GetCommand, response: { Item: { refreshToken: "existing-refresh-token" } } },
    ]);
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
    setupDbMock([
      { command: GetCommand, response: { Item: { refreshToken: "existing-refresh-token" } } },
    ]);
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
    setupDbMock([
      { command: GetCommand, response: { Item: { refreshToken: "existing-refresh-token" } } },
    ]);
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

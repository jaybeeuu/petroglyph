import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBTokenStore } from "./token-store-ddb.js";
import type { TokenRecord } from "@petroglyph/core";

const record: TokenRecord = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expirySeconds: 1_000_000,
  updatedAt: "2026-09-01T00:00:00.000Z",
  reconnectRequired: false,
};

function commandCall(
  send: ReturnType<typeof vi.fn>,
  index: number,
): { input: { [key: string]: unknown } } {
  return (send.mock.calls[index] as [{ input: { [key: string]: unknown } }])[0];
}

describe("DynamoDBTokenStore", () => {
  const options = { tableName: "petroglyph-refresh-tokens" };

  it("reads a record keyed by the composite (userId, provider) key", async () => {
    const send = vi.fn().mockResolvedValue({ Item: record });
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = new DynamoDBTokenStore({ ...options, client });

    const result = await store.read("github|12345", "onedrive");

    expect(result).toEqual(record);
    expect(commandCall(send, 0).input).toEqual({
      TableName: "petroglyph-refresh-tokens",
      Key: { userId: "github|12345", provider: "onedrive" },
    });
  });

  it("returns null when no record exists for the connection", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = new DynamoDBTokenStore({ ...options, client });

    await expect(store.read("github|12345", "onedrive")).resolves.toBeNull();
  });

  it("rejects a malformed stored record", async () => {
    const send = vi.fn().mockResolvedValue({
      Item: { accessToken: "access-1", provider: "onedrive" /* missing fields */ },
    });
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = new DynamoDBTokenStore({ ...options, client });

    await expect(store.read("github|12345", "onedrive")).rejects.toThrow();
  });

  it("blind write (bootstrap) puts the full record without a condition", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = new DynamoDBTokenStore({ ...options, client });

    const written = await store.write("github|12345", "onedrive", record, undefined);

    expect(written).toBe(true);
    const input = commandCall(send, 0).input as { Item?: unknown; ConditionExpression?: unknown };
    expect(input.Item).toEqual({ userId: "github|12345", provider: "onedrive", ...record });
    expect(input.ConditionExpression).toBeUndefined();
  });

  it("CAS write conditions on the expected record and reports failure on conflict", async () => {
    const conditionalFailure = Object.assign(new Error("The conditional request failed"), {
      name: "ConditionalCheckFailedException",
    });
    const send = vi.fn().mockRejectedValue(conditionalFailure);
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = new DynamoDBTokenStore({ ...options, client });

    const written = await store.write("github|12345", "onedrive", record, record);

    expect(written).toBe(false);
    const input = commandCall(send, 0).input as {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeValues: { [key: string]: unknown };
    };
    expect(input.UpdateExpression).toContain("SET");
    expect(input.ConditionExpression).toContain("updatedAt");
    expect(input.ConditionExpression).toContain("expirySeconds");
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":expectedUpdatedAt": record.updatedAt,
      ":expectedExpirySeconds": record.expirySeconds,
    });
  });

  it("CAS write succeeds when the condition holds", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = new DynamoDBTokenStore({ ...options, client });

    const written = await store.write("github|12345", "onedrive", record, record);

    expect(written).toBe(true);
  });

  it("rethrows non-condition failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("ProvisionedThroughputExceeded"));
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = new DynamoDBTokenStore({ ...options, client });

    await expect(store.write("github|12345", "onedrive", record, record)).rejects.toThrow();
  });

  describe("list", () => {
    it("returns every stored connection with its reconnect flag", async () => {
      const send = vi.fn().mockResolvedValue({
        Items: [
          { userId: "github|1", provider: "onedrive", reconnectRequired: false },
          { userId: "github|2", provider: "onedrive", reconnectRequired: true },
        ],
      });
      const client = { send } as unknown as DynamoDBDocumentClient;
      const store = new DynamoDBTokenStore({ ...options, client });

      const connections = await store.list();

      expect(connections).toEqual([
        { userId: "github|1", provider: "onedrive", reconnectRequired: false },
        { userId: "github|2", provider: "onedrive", reconnectRequired: true },
      ]);
      expect(commandCall(send, 0).input).toMatchObject({
        TableName: "petroglyph-refresh-tokens",
      });
    });

    it("pages through the whole table", async () => {
      const send = vi
        .fn()
        .mockResolvedValueOnce({
          Items: [{ userId: "github|1", provider: "onedrive", reconnectRequired: false }],
          LastEvaluatedKey: { userId: "github|1", provider: "onedrive" },
        })
        .mockResolvedValueOnce({
          Items: [{ userId: "github|2", provider: "onedrive", reconnectRequired: false }],
        });
      const client = { send } as unknown as DynamoDBDocumentClient;
      const store = new DynamoDBTokenStore({ ...options, client });

      const connections = await store.list();

      expect(connections.map((connection) => connection.userId)).toEqual(["github|1", "github|2"]);
      expect(commandCall(send, 1).input).toMatchObject({
        ExclusiveStartKey: { userId: "github|1", provider: "onedrive" },
      });
    });

    it("skips a row that fails the connection schema and keeps the healthy ones", async () => {
      const send = vi.fn().mockResolvedValue({
        Items: [
          { userId: "github|1", provider: "onedrive", reconnectRequired: false },
          { userId: "github|2", provider: "onedrive" },
        ],
      });
      const client = { send } as unknown as DynamoDBDocumentClient;
      const store = new DynamoDBTokenStore({ ...options, client, log: vi.fn() });

      const connections = await store.list();

      expect(connections).toEqual([
        { userId: "github|1", provider: "onedrive", reconnectRequired: false },
      ]);
    });

    it("names the skipped connection in the log", async () => {
      const send = vi.fn().mockResolvedValue({
        Items: [{ userId: "github|2", provider: "onedrive", reconnectRequired: null }],
      });
      const client = { send } as unknown as DynamoDBDocumentClient;
      const log = vi.fn();
      const store = new DynamoDBTokenStore({ ...options, client, log });

      await store.list();

      expect(log).toHaveBeenCalledWith(expect.stringContaining("github|2:onedrive"));
    });

    it("skips a row with no identity at all", async () => {
      const send = vi.fn().mockResolvedValue({
        Items: [
          { userId: "github|1", provider: "onedrive", reconnectRequired: false },
          { accessToken: "orphaned" },
        ],
      });
      const client = { send } as unknown as DynamoDBDocumentClient;
      const log = vi.fn();
      const store = new DynamoDBTokenStore({ ...options, client, log });

      const connections = await store.list();

      expect(connections.map((connection) => connection.userId)).toEqual(["github|1"]);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it("is empty when the table holds no connection", async () => {
      const send = vi.fn().mockResolvedValue({});
      const client = { send } as unknown as DynamoDBDocumentClient;
      const store = new DynamoDBTokenStore({ ...options, client });

      await expect(store.list()).resolves.toEqual([]);
    });
  });
});

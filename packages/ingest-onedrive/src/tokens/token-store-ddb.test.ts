import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createTokenStoreDdb } from "./token-store-ddb.js";
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

describe("createTokenStoreDdb", () => {
  const options = { tableName: "petroglyph-refresh-tokens" };

  it("reads a record keyed by the composite (userId, provider) key", async () => {
    const send = vi.fn().mockResolvedValue({ Item: record });
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = createTokenStoreDdb({ ...options, client });

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
    const store = createTokenStoreDdb({ ...options, client });

    await expect(store.read("github|12345", "onedrive")).resolves.toBeNull();
  });

  it("rejects a malformed stored record", async () => {
    const send = vi.fn().mockResolvedValue({
      Item: { accessToken: "access-1", provider: "onedrive" /* missing fields */ },
    });
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = createTokenStoreDdb({ ...options, client });

    await expect(store.read("github|12345", "onedrive")).rejects.toThrow();
  });

  it("blind write (bootstrap) puts the full record without a condition", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = createTokenStoreDdb({ ...options, client });

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
    const store = createTokenStoreDdb({ ...options, client });

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
    const store = createTokenStoreDdb({ ...options, client });

    const written = await store.write("github|12345", "onedrive", record, record);

    expect(written).toBe(true);
  });

  it("rethrows non-condition failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("ProvisionedThroughputExceeded"));
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = createTokenStoreDdb({ ...options, client });

    await expect(store.write("github|12345", "onedrive", record, record)).rejects.toThrow();
  });
});

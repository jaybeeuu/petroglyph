import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createDeltaStateStoreDdb } from "./delta-state-store-ddb.js";

function commandCall(
  send: ReturnType<typeof vi.fn>,
  index: number,
): {
  input: { [key: string]: unknown };
} {
  return (send.mock.calls[index] as [{ input: { [key: string]: unknown } }])[0];
}

const state = {
  deltaLink: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("createDeltaStateStoreDdb", () => {
  it("stores the opaque deltaLink per connection (userId, provider) on update set/write", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = createDeltaStateStoreDdb({ client, tableName: "delta-state" });

    await store.write("github|12345", "onedrive", state);

    const input = commandCall(send, 0).input;
    expect(input).toMatchObject({
      TableName: "delta-state",
      Key: { userId: "github|12345", provider: "onedrive" },
    });
    expect(input).toHaveProperty("UpdateExpression");
  });

  it("reads the stored link back verbatim — tokens are copied, never re-encoded", async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        userId: "github|12345",
        provider: "onedrive",
        deltaLink: state.deltaLink,
        updatedAt: state.updatedAt,
      },
    });
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = createDeltaStateStoreDdb({ client, tableName: "delta-state" });

    const result = await store.read("github|12345", "onedrive");

    expect(result).toEqual(state);
  });

  it("returns null when no state exists for the connection", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = createDeltaStateStoreDdb({ client, tableName: "delta-state" });

    await expect(store.read("github|12345", "onedrive")).resolves.toBeNull();
  });

  it("clears the stored state (410/syncStateNotFound reset path)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    const store = createDeltaStateStoreDdb({ client, tableName: "delta-state" });

    await store.clear("github|12345", "onedrive");

    const input = commandCall(send, 0).input;
    expect(input).toMatchObject({
      TableName: "delta-state",
      Key: { userId: "github|12345", provider: "onedrive" },
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createStagedIndexStoreDdb } from "./index-store-ddb.js";

function commandCall(
  send: ReturnType<typeof vi.fn>,
  index: number,
): {
  input: { [key: string]: unknown };
} {
  return (send.mock.calls[index] as [{ input: { [key: string]: unknown } }])[0];
}

const record = {
  profileId: "p1",
  itemId: "item-1",
  s3Key: "staging/v1/p1/notes/a.pdf",
  relativePath: "notes",
  name: "a.pdf",
  source: "onedrive",
  mimeType: "application/pdf",
  status: "staged" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
};

describe("createStagedIndexStoreDdb", () => {
  const options = { tableName: "petroglyph-file-records" };

  it("upserts the record under the composite {profileId, itemId} key", async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = createStagedIndexStoreDdb({
      ...options,
      client: { send } as unknown as DynamoDBDocumentClient,
    });

    await store.upsert(record);

    const input = commandCall(send, 0).input as { Item: { [key: string]: unknown } };
    expect(input.Item).toMatchObject({
      profileId: "p1",
      itemId: "item-1",
      s3Key: "staging/v1/p1/notes/a.pdf",
      status: "staged",
    });
  });

  it("reads a record back keyed by profileId+itemId, null when absent", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: record }).mockResolvedValueOnce({});
    const store = createStagedIndexStoreDdb({
      ...options,
      client: { send } as unknown as DynamoDBDocumentClient,
    });

    await expect(store.get("p1", "item-1")).resolves.toEqual(record);
    await expect(store.get("p1", "missing")).resolves.toBeNull();
    const input = commandCall(send, 0).input;
    expect(input).toMatchObject({
      TableName: "petroglyph-file-records",
      Key: { profileId: "p1", itemId: "item-1" },
    });
  });

  it("removes a record idempotently", async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = createStagedIndexStoreDdb({
      ...options,
      client: { send } as unknown as DynamoDBDocumentClient,
    });

    await store.remove("p1", "item-1");

    const input = commandCall(send, 0).input;
    expect(input).toMatchObject({
      TableName: "petroglyph-file-records",
      Key: { profileId: "p1", itemId: "item-1" },
    });
  });

  it("queries the feed ordered, cursor-paged via ExclusiveStartKey", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [record],
        LastEvaluatedKey: { profileId: "p1", itemId: "item-1" },
      })
      .mockResolvedValueOnce({ Items: [] });
    const store = createStagedIndexStoreDdb({
      ...options,
      client: { send } as unknown as DynamoDBDocumentClient,
    });

    const page1 = await store.queryFeed({ profileId: "p1", limit: 1 });
    expect(page1.records).toEqual([record]);
    expect(page1.nextCursor).toBe("item-1");

    const page2 = await store.queryFeed(
      page1.nextCursor === undefined
        ? { profileId: "p1", limit: 1 }
        : { profileId: "p1", limit: 1, cursor: page1.nextCursor },
    );
    expect(page2.records).toEqual([]);
    expect(page2.nextCursor).toBeUndefined();

    const secondInput = commandCall(send, 1).input as { ExclusiveStartKey?: unknown };
    expect(secondInput.ExclusiveStartKey).toEqual({ profileId: "p1", itemId: "item-1" });
  });

  it("lists records under a path and removes them in one sweep", async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = createStagedIndexStoreDdb({
      ...options,
      client: { send } as unknown as DynamoDBDocumentClient,
    });

    await store.listUnderPath("p1", "notes/sub");
    await store.removeUnderPath("p1", "notes/sub");

    const listInput = commandCall(send, 0).input as { FilterExpression?: string };
    expect(listInput.FilterExpression).toContain("#rel");
    expect(listInput.FilterExpression).toContain("begins_with");
    const removeInput = commandCall(send, 1).input as { [key: string]: unknown };
    expect(removeInput["TableName"]).toBe("petroglyph-file-records");
  });
});

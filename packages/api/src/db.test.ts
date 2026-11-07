import { describe, expect, it, vi } from "vitest";

const construction = vi.hoisted(() => ({ count: 0 }));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () {
    construction.count += 1;
  }),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: (client: unknown) => ({ send: vi.fn(), client }),
  },
}));

describe("docClient", () => {
  it("builds the client on first use and reuses it", async () => {
    const { docClient } = await import("./db.js");

    expect(construction.count).toBe(0);

    const client = docClient();

    expect(docClient()).toBe(client);
    expect(construction.count).toBe(1);
  });
});

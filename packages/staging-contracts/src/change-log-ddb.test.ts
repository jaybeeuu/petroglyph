import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBStagedChangeLog } from "./change-log-ddb.js";
import type { StagedChangeInput } from "./change-log.js";

function createChange(overrides: Partial<StagedChangeInput> = {}): StagedChangeInput {
  return {
    profileId: "p1",
    subscriptionId: "subscription-1",
    changeId: "p1:item-1:file:etag-1",
    itemId: "item-1",
    kind: "stage",
    relativePath: "notes",
    name: "a.pdf",
    mimeType: "application/pdf",
    s3Key: "staging/v1/p1/notes/a.pdf",
    recordedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

interface CommandInput {
  [key: string]: unknown;
}

function inputAt(send: ReturnType<typeof vi.fn>, index: number): CommandInput {
  return (send.mock.calls[index] as [{ input: CommandInput }])[0].input;
}

function createStore(send: ReturnType<typeof vi.fn>): DynamoDBStagedChangeLog {
  return new DynamoDBStagedChangeLog({
    client: { send } as unknown as DynamoDBDocumentClient,
    tableName: "petroglyph-staged-changes",
  });
}

function conditionalCheckFailed(): Error {
  const error = new Error("The conditional request failed");
  error.name = "ConditionalCheckFailedException";
  return error;
}

describe("DynamoDBStagedChangeLog.append", () => {
  it("allocates the next seq from the profile's counter and stores the row under the padded key", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({}) // change marker
      .mockResolvedValueOnce({ Attributes: { count: 7 } }) // counter
      .mockResolvedValueOnce({}); // log row

    await createStore(send).append(createChange());

    const marker = inputAt(send, 0);
    expect(marker).toMatchObject({
      TableName: "petroglyph-staged-changes",
      Item: {
        profileId: "p1",
        seq: "~change#p1:item-1:file:etag-1",
        changeId: "p1:item-1:file:etag-1",
      },
      ConditionExpression: "attribute_not_exists(#seq)",
    });

    const counter = inputAt(send, 1);
    expect(counter).toMatchObject({
      Key: { profileId: "p1", seq: "!seq" },
      UpdateExpression: "ADD #count :one",
      ReturnValues: "UPDATED_NEW",
    });

    const row = inputAt(send, 2);
    expect(row).toMatchObject({
      TableName: "petroglyph-staged-changes",
      Item: {
        profileId: "p1",
        subscriptionId: "subscription-1",
        seq: "00000000000000000007",
        itemId: "item-1",
        kind: "stage",
      },
    });
  });

  it("reports a redelivered change as a duplicate without allocating a seq", async () => {
    const send = vi.fn().mockRejectedValueOnce(conditionalCheckFailed());

    const outcome = await createStore(send).append(createChange());

    expect(outcome).toEqual({ status: "duplicate" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the append fails, so the retry can log the change", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({}) // change marker
      .mockRejectedValueOnce(new Error("counter unavailable"))
      .mockResolvedValueOnce({}); // marker release

    await expect(createStore(send).append(createChange())).rejects.toThrow("counter unavailable");

    expect(inputAt(send, 2)).toMatchObject({
      Key: { profileId: "p1", seq: "~change#p1:item-1:file:etag-1" },
    });
  });

  it("fails loudly when the counter returns no value rather than writing an unnumbered row", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(createStore(send).append(createChange())).rejects.toThrow(
      "counter for profile p1 returned no count",
    );
  });
});

describe("DynamoDBStagedChangeLog.read", () => {
  it("reads the profile's seq range strictly after the cursor, ascending, ceilinged above every digit", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Items: [] });

    await createStore(send).read({ profileId: "p1", after: 3, limit: 25 });

    const input = inputAt(send, 0);
    expect(input).toMatchObject({
      TableName: "petroglyph-staged-changes",
      KeyConditionExpression: "profileId = :profileId AND #seq BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":profileId": "p1",
        ":from": "00000000000000000004",
        ":to": ":",
      },
      ScanIndexForward: true,
      Limit: 25,
    });
  });

  it("reads from the first seq when no cursor is given, excluding the counter and change markers", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Items: [] });

    await createStore(send).read({ profileId: "p1" });

    expect(inputAt(send, 0)).toMatchObject({
      ExpressionAttributeValues: { ":from": "00000000000000000001", ":to": ":" },
    });
  });

  it("unpads a stored seq back to a number so the cursor arithmetic stays numeric", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          profileId: "p1",
          subscriptionId: "subscription-1",
          seq: "00000000000000000011",
          changeId: "p1:item-1:delete:",
          itemId: "item-1",
          kind: "delete",
          relativePath: "notes",
          recordedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      LastEvaluatedKey: { profileId: "p1", seq: "00000000000000000011" },
    });

    const changes = await createStore(send).read({ profileId: "p1" });

    expect(changes[0]).toMatchObject({ seq: 11, kind: "delete", itemId: "item-1" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
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

/** A real cancellation: the transaction wrote nothing and named why. */
function transactionCancelled(code: string): TransactionCanceledException {
  return new TransactionCanceledException({
    message: `Transaction cancelled because of ${code}`,
    $metadata: {},
    CancellationReasons: [{ Code: code, Message: code }],
  });
}

describe("DynamoDBStagedChangeLog.append", () => {
  it("writes the row and its dedupe marker in one transaction, under the padded seq key", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Attributes: { count: 7 } }) // counter
      .mockResolvedValueOnce({}); // transaction

    await createStore(send).append(createChange());

    expect(inputAt(send, 0)).toMatchObject({
      TableName: "petroglyph-staged-changes",
      Key: { profileId: "p1", seq: "!seq" },
      UpdateExpression: "ADD #count :one",
      ReturnValues: "UPDATED_NEW",
    });

    expect(inputAt(send, 1)).toMatchObject({
      TransactItems: [
        {
          Put: {
            TableName: "petroglyph-staged-changes",
            Item: {
              profileId: "p1",
              subscriptionId: "subscription-1",
              seq: "00000000000000000007",
              itemId: "item-1",
              kind: "stage",
            },
          },
        },
        {
          Put: {
            TableName: "petroglyph-staged-changes",
            Item: {
              profileId: "p1",
              seq: "~change#p1:item-1:file:etag-1",
              changeId: "p1:item-1:file:etag-1",
            },
            ConditionExpression: "attribute_not_exists(#seq)",
          },
        },
      ],
    });
  });

  it("reports a redelivered change as a duplicate without a second write", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Attributes: { count: 8 } })
      .mockRejectedValueOnce(transactionCancelled("ConditionalCheckFailed"));

    const outcome = await createStore(send).append(createChange());

    expect(outcome).toEqual({ status: "duplicate" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("surfaces a cancellation the marker did not cause, and the retry then appends", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Attributes: { count: 8 } })
      .mockRejectedValueOnce(transactionCancelled("TransactionConflict"))
      .mockResolvedValueOnce({ Attributes: { count: 9 } })
      .mockResolvedValueOnce({});

    const store = createStore(send);

    await expect(store.append(createChange())).rejects.toThrow("Transaction cancelled");
    expect(await store.append(createChange())).toEqual({ status: "appended" });
    expect(inputAt(send, 3)).toMatchObject({
      TransactItems: [
        { Put: { Item: { profileId: "p1", seq: "00000000000000000009" } } },
        { Put: { Item: { seq: "~change#p1:item-1:file:etag-1" } } },
      ],
    });
  });

  it("surfaces a write failure rather than reporting an append that did not happen", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Attributes: { count: 8 } })
      .mockRejectedValueOnce(new Error("transaction unavailable"));

    await expect(createStore(send).append(createChange())).rejects.toThrow(
      "transaction unavailable",
    );
  });

  it("fails loudly when the counter returns no value rather than writing an unnumbered row", async () => {
    const send = vi.fn().mockResolvedValueOnce({});

    await expect(createStore(send).append(createChange())).rejects.toThrow(
      "counter for profile p1 returned no count",
    );
    expect(send).toHaveBeenCalledTimes(1);
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

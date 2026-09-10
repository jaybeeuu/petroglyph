import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createEventLogWriter } from "./event-log.js";
import type { CloudEvent } from "./cloud-event.js";

const stagedEvent: CloudEvent<{ profileId: string }> = {
  specversion: "1.0",
  id: "75bcad3e-9e61-4f2e-9f4d-1f48f723c186",
  source: "onedrive://profiles/p1",
  type: "petroglyph.file.staged",
  time: "2026-09-03T12:00:00Z",
  datacontenttype: "application/json",
  dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
  data: { profileId: "p1" },
};

describe("createEventLogWriter", () => {
  it("stores the document keyed on source+id with a put-if-absent condition", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;

    const written = await createEventLogWriter({
      client,
      tableName: "petroglyph-event-log",
    }).putIfAbsent(stagedEvent);

    expect(written).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0] as [{ input: { Item: { [key: string]: unknown } } }];
    const command = call[0];
    expect(command.input).toMatchObject({
      TableName: "petroglyph-event-log",
      Item: {
        source: "onedrive://profiles/p1",
        id: "75bcad3e-9e61-4f2e-9f4d-1f48f723c186",
      },
      ConditionExpression: "attribute_not_exists(#source) AND attribute_not_exists(#id)",
    });
    expect(JSON.parse(command.input.Item["doc"] as string)).toEqual(stagedEvent);
  });

  it("reports false when the condition fails (duplicate source+id already logged)", async () => {
    const conditionalFailure = Object.assign(new Error("The conditional request failed"), {
      name: "ConditionalCheckFailedException",
    });
    const send = vi.fn().mockRejectedValue(conditionalFailure);
    const client = { send } as unknown as DynamoDBDocumentClient;

    const written = await createEventLogWriter({
      client,
      tableName: "petroglyph-event-log",
    }).putIfAbsent(stagedEvent);

    expect(written).toBe(false);
  });

  it("rethrows non-condition failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    const client = { send } as unknown as DynamoDBDocumentClient;

    await expect(
      createEventLogWriter({ client, tableName: "petroglyph-event-log" }).putIfAbsent(stagedEvent),
    ).rejects.toThrow("boom");
  });
});

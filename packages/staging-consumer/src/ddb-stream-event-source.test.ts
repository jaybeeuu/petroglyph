import { describe, expect, it } from "vitest";
import type { DynamoDBRecord } from "aws-lambda";
import { createDdbStreamEventSource } from "./ddb-stream-event-source.js";

const source = createDdbStreamEventSource();

describe("createDdbStreamEventSource", () => {
  it("reads the CE JSON document from an INSERT row's doc attribute", () => {
    const wireRecord: DynamoDBRecord = {
      eventName: "INSERT",
      dynamodb: { NewImage: { doc: { S: '{"specversion":"1.0"}' } } },
    };

    expect(source.readDocument(wireRecord)).toBe('{"specversion":"1.0"}');
  });

  it("reads no document from MODIFY/REMOVE rows on the immutable log", () => {
    for (const eventName of ["MODIFY", "REMOVE"] as const) {
      const wireRecord: DynamoDBRecord = {
        eventName,
        dynamodb: { NewImage: { doc: { S: '{"specversion":"1.0"}' } } },
      };

      expect(source.readDocument(wireRecord)).toBeUndefined();
    }
  });

  it("reads no document when the row carries no string doc attribute", () => {
    expect(
      source.readDocument({ eventName: "INSERT", dynamodb: { NewImage: {} } }),
    ).toBeUndefined();
    expect(
      source.readDocument({ eventName: "INSERT", dynamodb: { NewImage: { doc: { N: "1" } } } }),
    ).toBeUndefined();
    expect(source.readDocument({ eventName: "INSERT", dynamodb: {} })).toBeUndefined();
  });
});

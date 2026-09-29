import type { DynamoDBRecord } from "aws-lambda";
import type { EventSource } from "@petroglyph/events";

/**
 * The event log's DynamoDB Streams transport. The log is immutable and streamed
 * NEW_IMAGE, so only INSERT rows carry an event; the CE document is the JSON
 * string in `dynamodb.NewImage.doc.S`.
 */
export function createDdbStreamEventSource(): EventSource<DynamoDBRecord> {
  return {
    readDocument(record) {
      if (record.eventName !== "INSERT") {
        return undefined;
      }
      const rawDoc: unknown = record.dynamodb?.NewImage?.["doc"];
      if (
        typeof rawDoc !== "object" ||
        rawDoc === null ||
        !("S" in rawDoc) ||
        typeof rawDoc["S"] !== "string"
      ) {
        return undefined;
      }
      return rawDoc["S"];
    },
  };
}

import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { CloudEvent } from "./cloud-event.js";

/**
 * The registry's DDB transport (Q8): one CE document per row, keyed on
 * `source`+`id` with a put-if-absent condition — dedupe enforced at write,
 * centrally. DDB Streams pushes the row to consumers (6.5.2.2 forwarder).
 */
export interface EventLogWriter {
  /** True when the document was written; false when source+id already exists. */
  putIfAbsent(document: CloudEvent<unknown>): Promise<boolean>;
}

export function createEventLogWriter(options: {
  client: DynamoDBDocumentClient;
  tableName: string;
}): EventLogWriter {
  return {
    async putIfAbsent(document) {
      try {
        await options.client.send(
          new PutCommand({
            TableName: options.tableName,
            Item: {
              source: document.source,
              id: document.id,
              doc: JSON.stringify(document),
            },
            ConditionExpression: "attribute_not_exists(#source) AND attribute_not_exists(#id)",
            ExpressionAttributeNames: { "#source": "source", "#id": "id" },
          }),
        );
        return true;
      } catch (error) {
        if ((error as { name?: unknown }).name === "ConditionalCheckFailedException") {
          return false;
        }
        throw error;
      }
    },
  };
}

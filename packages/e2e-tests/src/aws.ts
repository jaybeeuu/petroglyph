import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";

/**
 * The few AWS operations the smoke needs, behind one port so the runner's
 * journey can be tested without AWS and the real wiring stays at the edge.
 */
export interface SmokeAws {
  deleteItem(table: string, key: { [key: string]: unknown }): Promise<void>;
  putItem(table: string, item: { [key: string]: unknown }): Promise<void>;
  getItem(
    table: string,
    key: { [key: string]: unknown },
  ): Promise<{ [key: string]: unknown } | null>;
  sendMessage(queueUrl: string, body: string, deduplicationId: string): Promise<void>;
  getParameter(name: string): Promise<string>;
}

export function createSmokeAws(options: {
  documentClient: DynamoDBDocumentClient;
  sqsClient: SQSClient;
  ssmClient: SSMClient;
}): SmokeAws {
  return {
    async deleteItem(table, key) {
      await options.documentClient.send(new DeleteCommand({ TableName: table, Key: key }));
    },

    async putItem(table, item) {
      await options.documentClient.send(new PutCommand({ TableName: table, Item: item }));
    },

    async getItem(table, key) {
      const result = await options.documentClient.send(
        new GetCommand({ TableName: table, Key: key }),
      );
      return result.Item ?? null;
    },

    async sendMessage(queueUrl, body, deduplicationId) {
      await options.sqsClient.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageGroupId: "smoke",
          MessageDeduplicationId: deduplicationId,
        }),
      );
    },

    async getParameter(name) {
      const result = await options.ssmClient.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      );
      const value = result.Parameter?.Value;
      if (value === undefined || value === "") {
        throw new Error(`SSM parameter has no value: ${name}`);
      }
      return value;
    },
  };
}

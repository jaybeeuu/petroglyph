import { SQSClient } from "@aws-sdk/client-sqs";

let cachedSqsClient: SQSClient | undefined;

/**
 * The SQS client, built on first use. Building it at module scope would make
 * importing this module an effect (petroglyph-1o2d).
 */
export function sqsClient(): SQSClient {
  cachedSqsClient ??= new SQSClient({});
  return cachedSqsClient;
}

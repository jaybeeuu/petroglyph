import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

let cachedDocClient: DynamoDBDocumentClient | undefined;

/**
 * The document client, built on first use. Building it at module scope would
 * make importing this module an effect (petroglyph-1o2d).
 */
export function docClient(): DynamoDBDocumentClient {
  cachedDocClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedDocClient;
}

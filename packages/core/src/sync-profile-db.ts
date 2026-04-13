import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { syncProfileSchema } from "./sync-profile.js";
import type { SyncProfile } from "./sync-profile.js";

export async function getProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
  profileId: string,
): Promise<SyncProfile | null> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { userId, profileId },
    }),
  );

  if (result.Item === undefined) {
    return null;
  }

  return syncProfileSchema.parse(result.Item);
}

export async function listProfiles(
  client: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
): Promise<SyncProfile[]> {
  const items: { [key: string]: unknown }[] = [];
  let lastEvaluatedKey: { [key: string]: unknown } | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of result.Items ?? []) {
      items.push(item);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey !== undefined);

  return items.map((item) => syncProfileSchema.parse(item));
}

export async function putProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  profile: SyncProfile,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: profile,
    }),
  );
}

export async function deleteProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
  profileId: string,
): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { userId, profileId },
    }),
  );
}

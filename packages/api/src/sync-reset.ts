import { DeleteParameterCommand } from "@aws-sdk/client-ssm";
import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { z } from "zod";
import { docClient } from "./db.js";
import { ssmClient } from "./ssm.js";

const DEFAULT_PROFILE_ID = "default";
const DELTA_TOKEN_PARAMETER = "/petroglyph/onedrive/delta-token";
const BATCH_DELETE_LIMIT = 25;
const MAX_BATCH_DELETE_ATTEMPTS = 5;

const syncResetRequestSchema = z.object({
  scope: z.enum(["server", "full"]),
});

interface FileRecordKey {
  profileId: string;
  fileId: string;
}

interface DynamoKey {
  [key: string]: unknown;
}

function fileRecordsTableName(): string {
  return process.env["FILE_RECORDS_TABLE"] ?? "petroglyph-file-records-default";
}

function parseFileRecordKeys(items: unknown[] | undefined): FileRecordKey[] {
  if (items === undefined) {
    return [];
  }

  return items.flatMap((item) => {
    const value = item as { [key: string]: unknown };

    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      typeof value["profileId"] !== "string" ||
      typeof value["fileId"] !== "string"
    ) {
      return [];
    }

    return [{ profileId: value["profileId"], fileId: value["fileId"] }];
  });
}

function isParameterNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "ParameterNotFound";
}

function parseUnprocessedFileRecordKeys(
  unprocessedItems: unknown,
  tableName: string,
): FileRecordKey[] {
  if (
    typeof unprocessedItems !== "object" ||
    unprocessedItems === null ||
    Array.isArray(unprocessedItems)
  ) {
    return [];
  }

  const tableRequests = (unprocessedItems as { [key: string]: unknown })[tableName];
  if (!Array.isArray(tableRequests)) {
    return [];
  }

  return tableRequests.flatMap((tableRequest) => {
    if (typeof tableRequest !== "object" || tableRequest === null || Array.isArray(tableRequest)) {
      return [];
    }

    const deleteRequest = (tableRequest as { [key: string]: unknown })["DeleteRequest"];
    if (
      typeof deleteRequest !== "object" ||
      deleteRequest === null ||
      Array.isArray(deleteRequest)
    ) {
      return [];
    }

    const key = (deleteRequest as { [key: string]: unknown })["Key"];
    if (typeof key !== "object" || key === null || Array.isArray(key)) {
      return [];
    }

    const value = key as { [key: string]: unknown };
    if (typeof value["profileId"] !== "string" || typeof value["fileId"] !== "string") {
      return [];
    }

    return [{ profileId: value["profileId"], fileId: value["fileId"] }];
  });
}

async function deleteDeltaToken(): Promise<void> {
  try {
    await ssmClient.send(
      new DeleteParameterCommand({
        Name: DELTA_TOKEN_PARAMETER,
      }),
    );
  } catch (error) {
    if (isParameterNotFoundError(error)) {
      return;
    }

    throw error;
  }
}

async function deleteFileRecordBatch(fileRecordKeys: FileRecordKey[]): Promise<void> {
  const tableName = fileRecordsTableName();
  let pendingFileRecordKeys = fileRecordKeys;

  for (let attempt = 1; attempt <= MAX_BATCH_DELETE_ATTEMPTS; attempt += 1) {
    const result = await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: pendingFileRecordKeys.map((fileRecordKey) => ({
            DeleteRequest: {
              Key: fileRecordKey,
            },
          })),
        },
      }),
    );

    pendingFileRecordKeys = parseUnprocessedFileRecordKeys(result.UnprocessedItems, tableName);

    if (pendingFileRecordKeys.length === 0) {
      return;
    }
  }

  throw new Error(`Failed to delete file records after ${MAX_BATCH_DELETE_ATTEMPTS} attempts`);
}

async function deleteFileRecords(profileId: string): Promise<void> {
  let exclusiveStartKey: DynamoKey | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: fileRecordsTableName(),
        KeyConditionExpression: "profileId = :profileId",
        ExpressionAttributeValues: {
          ":profileId": profileId,
        },
        ...(exclusiveStartKey !== undefined && {
          ExclusiveStartKey: exclusiveStartKey,
        }),
      }),
    );

    const fileRecordKeys = parseFileRecordKeys(result.Items);
    for (let index = 0; index < fileRecordKeys.length; index += BATCH_DELETE_LIMIT) {
      const batch = fileRecordKeys.slice(index, index + BATCH_DELETE_LIMIT);
      await deleteFileRecordBatch(batch);
    }

    exclusiveStartKey = result.LastEvaluatedKey as DynamoKey | undefined;
  } while (exclusiveStartKey !== undefined);
}

export async function handleSyncReset(c: Context): Promise<Response> {
  const rawBody: unknown = await c.req.json().catch((): undefined => undefined);
  const parsedBody = syncResetRequestSchema.safeParse(rawBody);

  if (!parsedBody.success) {
    return c.json({ error: "Invalid reset scope" }, 400);
  }

  await deleteDeltaToken();
  await deleteFileRecords(DEFAULT_PROFILE_ID);

  return parsedBody.data.scope === "full"
    ? c.json({ resetToken: true })
    : c.json({ resetToken: false });
}

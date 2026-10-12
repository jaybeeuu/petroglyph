import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { DynamoDBStagedIndexStore, S3StagedObjectStore } from "@petroglyph/staging-contracts";
import { createDispatchHandler, type DispatchDependencies } from "./dispatch.js";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} env var not set`);
  }
  return value;
}

function stagedRetentionSeconds(): number | undefined {
  const raw = process.env["STAGED_RETENTION_SECONDS"];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const seconds = Number.parseInt(raw, 10);
  return Number.isNaN(seconds) ? undefined : seconds;
}

function createDependencies(): DispatchDependencies {
  const ttlSeconds = stagedRetentionSeconds();
  return {
    index: new DynamoDBStagedIndexStore({
      client: docClient,
      tableName: requiredEnv("FILE_RECORDS_TABLE"),
    }),
    objectStore: new S3StagedObjectStore({
      bucket: requiredEnv("STAGED_PDFS_BUCKET"),
      region: process.env["AWS_REGION"] ?? "eu-west-2",
    }),
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  };
}

/**
 * 6.5.2.3 dispatch lambda entrypoint: the composition root that binds the
 * handler to its runtime config. Dependencies are built per invocation so
 * missing configuration fails fast at cold start.
 */
export const handler = (event: SQSEvent): Promise<SQSBatchResponse> =>
  createDispatchHandler(createDependencies())(event);

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { docClient } from "./db.js";

function syncJobsTableName(): string {
  return process.env["SYNC_JOBS_TABLE"] ?? "petroglyph-sync-jobs-default";
}

interface SyncJob {
  jobId: string;
  userId: string;
  status: string;
  fileCount?: number;
  errorMessage?: string;
}

function parseSyncJob(item: unknown): SyncJob | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }

  const record = item as { [key: string]: unknown };
  const jobId = record["jobId"];
  const userId = record["userId"];
  const status = record["status"];

  if (typeof jobId !== "string" || typeof userId !== "string" || typeof status !== "string") {
    return null;
  }

  const fileCount = record["fileCount"];
  const errorMessage = record["errorMessage"];

  return {
    jobId,
    userId,
    status,
    ...(typeof fileCount === "number" && { fileCount }),
    ...(typeof errorMessage === "string" && { errorMessage }),
  };
}

export async function handleSyncJobStatus(c: Context): Promise<Response> {
  const jobId = c.req.param("jobId");
  const userIdValue: unknown = c.get("userId");
  if (typeof userIdValue !== "string" || userIdValue.length === 0) {
    throw new Error("Missing userId in sync job status context");
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: syncJobsTableName(),
      Key: { jobId },
    }),
  );

  const job = parseSyncJob(result.Item);
  if (job === null || job.userId !== userIdValue) {
    return c.json({ error: "Sync job not found" }, 404);
  }

  const body: { status: string; fileCount?: number; error?: string } = { status: job.status };
  if (job.fileCount !== undefined) {
    body.fileCount = job.fileCount;
  }
  if (job.errorMessage !== undefined) {
    body.error = job.errorMessage;
  }

  return c.json(body);
}

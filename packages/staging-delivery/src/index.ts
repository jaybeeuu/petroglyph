import { listProfiles, createS3ObjectStore } from "@petroglyph/core";
import { createStagedIndexStoreDdb } from "@petroglyph/staging-consumer";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle } from "hono/aws-lambda";
import { createFilesRouter } from "./app.js";
import { authMiddleware } from "./auth-middleware.js";
import { docClient } from "./db.js";

function fileRecordsTableName(): string {
  return process.env["FILE_RECORDS_TABLE"] ?? "petroglyph-file-records-default";
}

function syncProfilesTableName(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}

function stagedBucketName(): string {
  const bucket = process.env["STAGED_PDFS_BUCKET"];
  if (bucket === undefined) {
    console.warn("[staging-delivery] STAGED_PDFS_BUCKET not set — presigned URLs will fail");
    return "";
  }
  return bucket;
}

/**
 * The staging delivery lambda (6ra.5.2.4): the plugin's ONLY file-flow
 * surface, wired to the staging index + S3. Auth is layer-1 identity
 * deferred as-is (GitHub JWT); the router is pure — env-built deps here.
 */
export function createApp(): Hono {
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: ["app://obsidian.md", "capacitor://localhost", "http://localhost"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
    }),
  );
  app.use("/files/*", authMiddleware);

  app.route(
    "/",
    createFilesRouter({
      index: createStagedIndexStoreDdb({
        client: docClient,
        tableName: fileRecordsTableName(),
      }),
      objectStore: createS3ObjectStore({
        bucket: stagedBucketName(),
        region: process.env["AWS_REGION"] ?? "eu-west-2",
      }),
      listProfiles: (userId) => listProfiles(docClient, syncProfilesTableName(), userId),
    }),
  );
  return app;
}

const app = createApp();

export const handler = handle(app);

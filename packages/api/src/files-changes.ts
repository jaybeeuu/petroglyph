import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { docClient } from "./db.js";
import { ssmClient } from "./ssm.js";

const DEFAULT_PROFILE_ID = "default";
const INITIAL_SYNC_PARAMETER = "/petroglyph/config/initial-sync";
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const PRESIGNED_URL_EXPIRES_IN_SECONDS = 15 * 60;

const s3Client = new S3Client({});

const fileChangesQuerySchema = z.object({
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const cursorSchema = z.object({
  profileId: z.string().min(1),
  fileId: z.string().min(1),
});

const fileRecordSchema = z.object({
  profileId: z.string().min(1),
  fileId: z.string().min(1),
  filename: z.string().min(1),
  createdAt: z.string().min(1),
  s3Key: z.string().min(1),
  pageCount: z.number().int().positive().optional(),
});

const queryResultSchema = z.object({
  Items: z.array(fileRecordSchema).optional(),
  LastEvaluatedKey: cursorSchema.optional(),
});

const initialSyncValueSchema = z.enum(["true", "false"]).transform((value) => value === "true");

interface FileChange {
  fileId: string;
  s3PresignedUrl: string;
  filename: string;
  createdAt: string;
  pageCount?: number;
}

interface FileRecord {
  profileId: string;
  fileId: string;
  filename: string;
  createdAt: string;
  s3Key: string;
  pageCount?: number;
}

interface CursorToken {
  profileId: string;
  fileId: string;
}

function fileRecordsTableName(): string {
  return process.env["FILE_RECORDS_TABLE"] ?? "petroglyph-file-records-default";
}

function stagedBucketName(): string {
  const bucketName = process.env["STAGED_PDFS_BUCKET"];
  if (!bucketName) {
    throw new Error("STAGED_PDFS_BUCKET env var not set");
  }

  return bucketName;
}

function parseCursorToken(token: string): CursorToken {
  const rawToken = Buffer.from(token, "base64url").toString("utf8");
  const parsedToken: unknown = JSON.parse(rawToken) as unknown;
  const parsed = cursorSchema.safeParse(parsedToken);

  if (!parsed.success) {
    throw new Error("Invalid file changes cursor");
  }

  return parsed.data;
}

function encodeCursorToken(cursor: CursorToken): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

async function readInitialSyncEnabled(): Promise<boolean> {
  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: INITIAL_SYNC_PARAMETER,
      WithDecryption: true,
    }),
  );

  return initialSyncValueSchema.parse(result.Parameter?.Value);
}

async function readFileRecordPage(
  limit: number,
  exclusiveStartKey?: CursorToken,
): Promise<{ fileRecords: FileRecord[]; nextToken: string | null }> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: fileRecordsTableName(),
      KeyConditionExpression: "profileId = :profileId",
      ExpressionAttributeValues: {
        ":profileId": DEFAULT_PROFILE_ID,
      },
      Limit: limit,
      ScanIndexForward: true,
      ...(exclusiveStartKey !== undefined && {
        ExclusiveStartKey: exclusiveStartKey,
      }),
    }),
  );

  const parsed = queryResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error("Invalid file records response");
  }

  const fileRecords = [...(parsed.data.Items ?? [])].sort((left, right) => {
    const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
    if (createdAtComparison !== 0) {
      return createdAtComparison;
    }

    return left.fileId.localeCompare(right.fileId);
  });

  return {
    fileRecords,
    nextToken:
      parsed.data.LastEvaluatedKey !== undefined
        ? encodeCursorToken(parsed.data.LastEvaluatedKey)
        : null,
  };
}

async function presignFileRecord(fileRecord: FileRecord): Promise<FileChange> {
  const s3PresignedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: stagedBucketName(),
      Key: fileRecord.s3Key,
    }),
    { expiresIn: PRESIGNED_URL_EXPIRES_IN_SECONDS },
  );

  return {
    fileId: fileRecord.fileId,
    s3PresignedUrl,
    filename: fileRecord.filename,
    createdAt: fileRecord.createdAt,
    ...(fileRecord.pageCount !== undefined && { pageCount: fileRecord.pageCount }),
  };
}

export async function handleFilesChanges(c: Context): Promise<Response> {
  const query = fileChangesQuerySchema.safeParse({
    after: c.req.query("after"),
    limit: c.req.query("limit"),
  });

  if (!query.success) {
    return c.json({ error: "Invalid files changes query" }, 400);
  }

  if (query.data.after === undefined) {
    const initialSyncEnabled = await readInitialSyncEnabled();
    if (!initialSyncEnabled) {
      return c.json({ files: [], nextToken: null });
    }
  }

  let exclusiveStartKey: CursorToken | undefined;
  if (query.data.after !== undefined) {
    try {
      exclusiveStartKey = parseCursorToken(query.data.after);
    } catch {
      return c.json({ error: "Invalid file changes cursor" }, 400);
    }
  }

  const { fileRecords, nextToken } = await readFileRecordPage(
    query.data.limit,
    exclusiveStartKey,
  );

  const files = await Promise.all(fileRecords.map(async (fileRecord) => presignFileRecord(fileRecord)));

  return c.json({ files, nextToken });
}

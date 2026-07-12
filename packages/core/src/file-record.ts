import { z } from "zod";

export const fileRecordStatusEnum = z.enum(["pending", "staged"]);
export type FileRecordStatus = z.infer<typeof fileRecordStatusEnum>;

const pendingFileRecordSchema = z.object({
  profileId: z.string().min(1),
  fileId: z.string().min(1),
  filename: z.string().min(1),
  createdAt: z.string().min(1),
  s3Key: z.literal(""),
  status: z.literal("pending"),
  pageCount: z.number().int().positive().optional(),
});

const stagedFileRecordSchema = z.object({
  profileId: z.string().min(1),
  fileId: z.string().min(1),
  filename: z.string().min(1),
  createdAt: z.string().min(1),
  s3Key: z.string().min(1),
  status: z.literal("staged"),
  pageCount: z.number().int().positive().optional(),
});

export const fileRecordSchema = z.discriminatedUnion("status", [
  pendingFileRecordSchema,
  stagedFileRecordSchema,
]);

export type PendingFileRecord = z.infer<typeof pendingFileRecordSchema>;
export type StagedFileRecord = z.infer<typeof stagedFileRecordSchema>;
export type FileRecord = z.infer<typeof fileRecordSchema>;

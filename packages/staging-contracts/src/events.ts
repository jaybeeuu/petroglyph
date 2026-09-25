import { z } from "zod";
import { registerEvent } from "@petroglyph/events";

export const stagedChangeTypeSchema = z.enum(["created", "updated"]);
export const deletedChangeTypeSchema = z.literal("deleted");

/**
 * FileStagedData — the real seam into Unit 2: a fact about bytes we hold in
 * S3. mimeType is REQUIRED and always the magic-byte-detected type of the
 * landed body (detectType), never a persisted vendor claim. Strict mode
 * rejects OneDrive-shaped fields (parentReference / tokenHash / driveItem).
 */
export const fileStagedDataSchema = z
  .object({
    profileId: z.string().min(1),
    source: z.string().min(1),
    changeType: stagedChangeTypeSchema,
    itemId: z.string().min(1),
    name: z.string().min(1),
    relativePath: z.string().min(1),
    s3Key: z.string().min(1),
    mimeType: z.string().min(1),
  })
  .strict();

export type FileStagedData = z.infer<typeof fileStagedDataSchema>;

/**
 * FileDeletedData — carries where the file was removed FROM in S3 (s3Key
 * string), or null when no object was staged (folder path-level deletes).
 */
export const fileDeletedDataSchema = z
  .object({
    profileId: z.string().min(1),
    source: z.string().min(1),
    changeType: deletedChangeTypeSchema,
    itemId: z.string().min(1),
    relativePath: z.string().min(1),
    s3Key: z.string().min(1).nullable(),
  })
  .strict();

export type FileDeletedData = z.infer<typeof fileDeletedDataSchema>;

export const fileStagedEvent = registerEvent({
  type: "petroglyph.file.staged",
  dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
  dataSchema: fileStagedDataSchema,
});

export const fileDeletedEvent = registerEvent({
  type: "petroglyph.file.deleted",
  dataschema: "https://schemas.petroglyph.dev/file-deleted/v1.json",
  dataSchema: fileDeletedDataSchema,
});

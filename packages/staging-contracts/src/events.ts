import { z } from "zod";
import { cloudEventSchema } from "@petroglyph/events";

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
 * FileDeletedData — the item identity, plus OPTIONAL sweep hints.
 *
 * The adapter owns only the identity: Graph strips the name and the parent path
 * on delete, so a deletion cannot be placed by path. Unit 2 resolves the object
 * from its own index record by `{profileId, itemId}`.
 *
 * `relativePath` and `s3Key` are hints for the ONE case the adapter can still
 * place: a deleted folder whose parent path and name both survived on the wire.
 * `relativePath` is then the deleted thing's own path and `s3Key` is null, which
 * asks the consumer to sweep every record under that path. Both are optional,
 * so the four-field payload is the common case and stored rows still parse.
 */
export const fileDeletedDataSchema = z
  .object({
    profileId: z.string().min(1),
    source: z.string().min(1),
    changeType: deletedChangeTypeSchema,
    itemId: z.string().min(1),
    relativePath: z.string().min(1).optional(),
    s3Key: z.string().min(1).nullable().optional(),
  })
  .strict();

export type FileDeletedData = z.infer<typeof fileDeletedDataSchema>;

export const fileStagedEvent = cloudEventSchema(fileStagedDataSchema).extend({
  type: z.literal("petroglyph.file.staged"),
  dataschema: z.literal("https://schemas.petroglyph.dev/file-staged/v1.json"),
});

export const fileDeletedEvent = cloudEventSchema(fileDeletedDataSchema).extend({
  type: z.literal("petroglyph.file.deleted"),
  dataschema: z.literal("https://schemas.petroglyph.dev/file-deleted/v1.json"),
});

import { z } from "zod";

/**
 * The neutral index record — Unit 2's read model, keyed {profileId, itemId}.
 * Staged-only: a record exists only after a FileStagedEvent applied; deletes
 * remove it. Delivery readers follow stored s3Key (never derive keys).
 */
export const stagedRecordSchema = z.object({
  profileId: z.string().min(1),
  itemId: z.string().min(1),
  s3Key: z.string().min(1),
  relativePath: z.string(),
  name: z.string().min(1),
  source: z.string().min(1),
  mimeType: z.string().min(1),
  /**
   * The source driveItem's `eTag` — the version a reader reconciles on. OPTIONAL
   * because two producers cannot always supply it: rows staged before the field
   * existed, and a delta page that omitted the top-level property. An absent
   * version means "unknown", never "unchanged": a reader must download and
   * byte-compare rather than skip.
   */
  eTag: z.string().min(1).optional(),
  status: z.literal("staged"),
  createdAt: z.string().min(1),
  /** Epoch seconds; DDB TTL aligns the row with the S3 expire-staged-pdfs lifecycle. */
  expiresAt: z.number().int().optional(),
});

export type StagedRecord = z.infer<typeof stagedRecordSchema>;

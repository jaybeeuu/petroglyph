import { z } from "zod";
import { subscriptionIdOf } from "./change-log.js";

/**
 * The row as the table stores it. `subscriptionId` is optional here because the
 * release before the sync unit shipped wrote rows without it, and those rows
 * stay readable until their TTL expires: a required field would turn every one
 * of them into a parse error on `get` and `listUnderPath`.
 */
const storedStagedRecordSchema = z.object({
  profileId: z.string().min(1),
  subscriptionId: z.string().min(1).optional(),
  itemId: z.string().min(1),
  s3Key: z.string().min(1),
  relativePath: z.string(),
  name: z.string().min(1),
  source: z.string().min(1),
  mimeType: z.string().min(1),
  status: z.literal("staged"),
  createdAt: z.string().min(1),
  /** Epoch seconds; DDB TTL aligns the row with the S3 expire-staged-pdfs lifecycle. */
  expiresAt: z.number().int().optional(),
});

/**
 * The neutral index record — Unit 2's read model, keyed {profileId, itemId}.
 * Staged-only: a record exists only after a FileStagedEvent applied; deletes
 * remove it. Delivery readers follow stored s3Key (never derive keys).
 *
 * `subscriptionId` records the root the bytes came through alongside the
 * profile that owns them, so the sync unit can flip from profile to
 * subscription without a schema migration. A row the previous release wrote
 * has no such attribute, so the parse resolves it through `subscriptionIdOf`:
 * every reader sees the sync unit, never `undefined`.
 */
export const stagedRecordSchema = storedStagedRecordSchema.transform((stored) => ({
  ...stored,
  subscriptionId: subscriptionIdOf(stored),
}));

export type StagedRecord = z.infer<typeof stagedRecordSchema>;

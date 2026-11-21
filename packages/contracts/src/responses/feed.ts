import { z } from "zod";

/**
 * One delivered file, as `GET /files` lists it and `GET /files/{itemId}` returns
 * it. Served by `packages/staging-delivery`, described here so the registry stays
 * the one place that spells the surface.
 */
export const feedEntryResponseSchema = z.object({
  itemId: z.string().min(1),
  name: z.string().min(1),
  relativePath: z.string(),
  mimeType: z.string().min(1),
  s3PresignedUrl: z.string().min(1),
  createdAt: z.string().min(1),
  /**
   * The source item's version, so a reader can tell a changed item from an
   * unchanged one without downloading. Absent when the staged record carries
   * none, which is every record staged before the field existed.
   */
  eTag: z.string().min(1).optional(),
});

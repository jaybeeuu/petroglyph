import { z } from "zod";

const feedEntrySchema = z.object({
  itemId: z.string().min(1),
  name: z.string().min(1),
  relativePath: z.string(),
  mimeType: z.string().min(1),
  s3PresignedUrl: z.url(),
  createdAt: z.string().min(1),
});

const feedResponseSchema = z.object({
  files: z.array(feedEntrySchema),
  nextToken: z.string().nullable(),
});

export type FeedEntry = z.infer<typeof feedEntrySchema>;

/** Validates the delivery surface's page at the JSON boundary. */
export function parseFeed(body: unknown): FeedEntry[] {
  return feedResponseSchema.parse(body).files;
}

/** PDF magic-byte check — the same first five bytes `detectType` verifies. */
export function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

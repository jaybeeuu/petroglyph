import { z } from "zod";

export const feedCursorSchema = z.object({
  profileId: z.string().min(1),
  itemId: z.string().min(1),
});

export type FeedCursor = z.infer<typeof feedCursorSchema>;

/**
 * Opaque page cursor for the /files feed. Binds the page to the owning
 * profile so a mid-pagination profile switch cannot silently re-scope the
 * reader; decoded profileIds are re-verified against the authenticated
 * user's profiles on every request (auth scoping, never trust the token).
 */
export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeFeedCursor(token: string): FeedCursor {
  const raw = Buffer.from(token, "base64url").toString("utf8");
  return feedCursorSchema.parse(JSON.parse(raw) as unknown);
}

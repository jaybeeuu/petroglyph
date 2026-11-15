import { z } from "zod";

/**
 * The page cursor a client holds. Opaque to callers: nothing in the API
 * contract describes its internals, so the shape may change between releases.
 * It binds the page to the owning profile so a mid-pagination profile switch
 * cannot silently re-scope the reader, and it carries the change log's `seq`
 * — never a provider token and never an itemId.
 */
export const feedCursorSchema = z.object({
  profileId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});

export type FeedCursor = z.infer<typeof feedCursorSchema>;

export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * Decodes a cursor, or throws when it is not one this release can resume from.
 * A cursor from an older internal format fails here on purpose: the route turns
 * that into a 400 and the client restarts the drain once from the head.
 */
export function decodeFeedCursor(token: string): FeedCursor {
  const raw = Buffer.from(token, "base64url").toString("utf8");
  return feedCursorSchema.parse(JSON.parse(raw) as unknown);
}

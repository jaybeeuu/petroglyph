import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The per-connection catch-up bell. The webhook receiver, a Sync-Now request
 * and the scheduled sweep all publish this same body; the adapter consumes it.
 */
export const deltaTriggerSchema = z.object({
  userId: z.string().min(1),
  provider: z.string().min(1),
});

export type DeltaTrigger = z.infer<typeof deltaTriggerSchema>;

/**
 * The FIFO deduplication id for a continuation bell. This queue has no
 * content-based deduplication, and the body of every bell is the same
 * per-connection pair, so the id has to come from somewhere else. The resume
 * link is the identity of one continuation — one per page boundary — so two
 * sends of the same resume point collapse into one walk while two different
 * points do not. A time-bucketed id (what the catch-up sweep uses) would
 * swallow the next continuation and stall the catch-up mid-drive. Hashed
 * because the link is an opaque URL far beyond SQS's 128-character limit.
 */
export function continuationDedupeId(resumeLink: string): string {
  return createHash("sha256").update(resumeLink).digest("hex");
}

import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The per-connection delta bell. Every producer — the scheduled catch-up sweep,
 * the adapter's own page-continuation and a user's Sync Now — publishes this
 * same body, and the adapter consumes it. One definition, in the contracts
 * package, so a producer cannot drift from the consumer.
 */
export const deltaTriggerSchema = z.object({
  userId: z.string().min(1),
  provider: z.string().min(1),
});

export type DeltaTrigger = z.infer<typeof deltaTriggerSchema>;

/**
 * One FIFO delivery of a bell: the `SendMessage` arguments every producer
 * sends. Named for the API it feeds, and plain data so this package stays free
 * of the AWS SDK.
 */
export interface DeltaTriggerSend {
  readonly QueueUrl: string;
  readonly MessageBody: string;
  readonly MessageGroupId: string;
  readonly MessageDeduplicationId: string;
}

/**
 * SQS caps the deduplication id at 128 characters and every producer's
 * identity is either unbounded (a resume link) or easier to read hashed, so the
 * id is always a sha256 hex digest of the identity the caller chose.
 */
export function deltaTriggerDedupeId(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * The one way to address a bell on the delta-trigger FIFO queue: the body is
 * the bell, the group is the connection (so one connection's bells stay
 * ordered), and the deduplication id hashes the caller's identity for the
 * delivery. `dedupeIdentity` is what makes two sends the same delivery — the
 * connection key for Sync Now and the continuation's resume link for the
 * adapter — and SQS collapses repeats inside its five-minute window.
 */
export function createDeltaTriggerSend(options: {
  queueUrl: string;
  bell: DeltaTrigger;
  dedupeIdentity: string;
}): DeltaTriggerSend {
  return {
    QueueUrl: options.queueUrl,
    MessageBody: JSON.stringify(options.bell),
    MessageGroupId: `${options.bell.userId}:${options.bell.provider}`,
    MessageDeduplicationId: deltaTriggerDedupeId(options.dedupeIdentity),
  };
}

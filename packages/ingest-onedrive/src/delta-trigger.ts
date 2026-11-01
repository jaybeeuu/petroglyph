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

import { z } from "zod";

export const syncProfileSchema = z.object({
  profileId: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  sourceFolderPath: z.string().min(1),
  destinationVaultPath: z.string().min(1),
  pollingIntervalMinutes: z.number().int().positive().default(5),
  enabled: z.boolean().default(true),
  active: z.boolean(),
  initialSyncEnabled: z.boolean().default(true),
  /**
   * Set by the write path when `sourceFolderPath` changes, cleared by the walk
   * that honours it. While true the connection owes a full re-enumerate: the
   * staged state was deleted and the stored change token no longer covers the
   * drive. Server-owned — the update body is strict, so a client cannot set it.
   */
  deltaResetPending: z.boolean().optional(),
  /**
   * Set by the write path while the sweep of this profile's staged records and
   * objects is unfinished, cleared only by a reset that discarded every one of
   * them. The walk ignores it: re-enumerating the drive is a separate
   * obligation with its own marker above. Server-owned.
   */
  stagedSweepPending: z.boolean().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type SyncProfile = z.infer<typeof syncProfileSchema>;

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
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /**
   * Set when the user deletes the profile. The row is retained for audit, so
   * every reader must exclude it: `getProfile` answers null and `listProfiles`
   * drops the row, which is the single filter no caller can forget.
   */
  deletedAt: z.string().min(1).optional(),
});

export type SyncProfile = z.infer<typeof syncProfileSchema>;

import { z } from "zod";

export const syncProfileSchema = z.object({
  profileId: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  sourceFolderPath: z.string().min(1),
  pollingIntervalMinutes: z.number().int().positive().default(5),
  enabled: z.boolean().default(true),
  active: z.boolean(),
  initialSyncEnabled: z.boolean().default(true),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /**
   * Set when the profile is soft-deleted. A deleted profile is gone, never
   * empty: every profile-scoped route answers `410` for it.
   */
  deletedAt: z.string().min(1).optional(),
});

export type SyncProfile = z.infer<typeof syncProfileSchema>;

/**
 * Whether the profile has been soft-deleted. A deleted profile answers `410`
 * from the moment `deletedAt` is written, so a client stops instead of reading
 * an empty feed and pruning what it already wrote.
 */
export function isDeletedProfile(profile: Pick<SyncProfile, "deletedAt">): boolean {
  return profile.deletedAt !== undefined;
}

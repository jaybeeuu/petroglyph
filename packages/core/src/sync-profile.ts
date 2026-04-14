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
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type SyncProfile = z.infer<typeof syncProfileSchema>;

import { z } from "zod";

/**
 * A sync profile as this API sends it. The operations registry may import only
 * zod (`test/operations-purity.test.ts`), so the wire shape is stated here
 * instead of imported from `@petroglyph/core`: the domain schema in that package
 * reads a stored record, this one describes what a client receives.
 */
export const syncProfileResponseSchema = z.object({
  profileId: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  sourceFolderPath: z.string().min(1),
  destinationVaultPath: z.string().min(1),
  pollingIntervalMinutes: z.number().int().positive(),
  enabled: z.boolean(),
  active: z.boolean(),
  initialSyncEnabled: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

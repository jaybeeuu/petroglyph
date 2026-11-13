import { z } from "zod";
import { defineOperation } from "../operation.js";
import { syncProfileResponseSchema } from "../responses/sync-profile.js";

/**
 * The body of a new profile. `sourceFolderPath` is only checked for presence
 * here: the canonical form (no leading slash, no repeated slashes) is the sync
 * walker's rule, so the handler normalises it with the domain helper.
 */
export const createProfileBodySchema = z.object({
  name: z.string().min(1),
  sourceFolderPath: z.string().min(1),
  destinationVaultPath: z.string().min(1),
  pollingIntervalMinutes: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

export const createProfile = defineOperation({
  id: "createProfile",
  method: "post",
  path: "/profiles",
  summary: "Create a sync profile",
  tags: ["profiles"],
  request: {
    body: createProfileBodySchema,
    rejection: { error: "Invalid profile data", includeIssues: true },
  },
  responses: { 201: syncProfileResponseSchema },
});

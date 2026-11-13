import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";
import { syncProfileResponseSchema } from "../responses/sync-profile.js";

/** Path parameter of every `/profiles/{id}` operation. */
export const profileIdParamsSchema = z.object({ id: z.string().min(1) });

/**
 * A partial profile update. Strict, so a misspelled key is rejected rather than
 * silently ignored: a rename that nobody applied is worse than a 400.
 * `sourceFolderPath` keeps the presence check only; see create-profile.
 */
export const putProfileBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    sourceFolderPath: z.string().min(1).optional(),
    destinationVaultPath: z.string().min(1).optional(),
    pollingIntervalMinutes: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    initialSyncEnabled: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();

/** The profile as stored, plus the profiles the update deactivated to activate it. */
const putProfileResponseSchema = syncProfileResponseSchema.extend({
  deactivatedProfileIds: z.array(z.string()),
});

export const putProfile = defineOperation({
  id: "putProfile",
  method: "put",
  path: "/profiles/{id}",
  summary: "Replace one sync profile",
  tags: ["profiles"],
  request: {
    params: profileIdParamsSchema,
    body: putProfileBodySchema,
    rejection: { error: "Invalid request body", includeIssues: true },
  },
  responses: {
    200: putProfileResponseSchema,
    404: flatErrorSchema,
    409: flatErrorSchema,
  },
});

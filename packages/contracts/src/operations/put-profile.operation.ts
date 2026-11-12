import { z } from "zod";
import { defineOperation } from "../operation.js";

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
});

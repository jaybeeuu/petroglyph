import { z } from "zod";
import { defineOperation } from "../operation.js";
import { structuredErrorSchema } from "../responses/error.js";
import { profileIdParamsSchema } from "./put-profile.operation.js";

/**
 * Sync Now for one profile: enqueue one delta bell and answer 202. The profile
 * is named in the path, never resolved from a server-side active flag, so a
 * deleted profile has no route that can still work — it answers `410` from the
 * moment `deletedAt` is written.
 *
 * The 409s are the two ways a connection can be unusable, and they are the
 * operations that speak the structured envelope: a client branches on `code`.
 */
export const postProfileSyncTrigger = defineOperation({
  id: "postProfileSyncTrigger",
  method: "post",
  path: "/profiles/{id}/sync-trigger",
  summary: "Enqueue one delta walk for a profile (Sync Now)",
  tags: ["profiles"],
  request: {
    params: profileIdParamsSchema,
    rejection: { error: "Invalid profile id" },
  },
  responses: {
    202: z.object({ status: z.literal("queued") }),
    404: structuredErrorSchema,
    409: structuredErrorSchema,
    410: structuredErrorSchema,
  },
});

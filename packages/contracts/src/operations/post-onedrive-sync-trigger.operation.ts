import { z } from "zod";
import { defineOperation } from "../operation.js";
import { structuredErrorSchema } from "../responses/error.js";

/**
 * Sync Now: enqueue one delta bell for the caller's OneDrive connection and
 * answer 202. The plugin then polls `GET /files` as it already does, so this
 * route has no job record and no status to poll.
 *
 * The 409s are the two ways a connection can be unusable, and they are the
 * operations that speak the structured envelope: a client branches on `code`.
 */
export const postOnedriveSyncTrigger = defineOperation({
  id: "postOnedriveSyncTrigger",
  method: "post",
  path: "/onedrive/sync-trigger",
  summary: "Enqueue a OneDrive delta walk for the caller's connection (Sync Now)",
  tags: ["onedrive"],
  responses: {
    202: z.object({ status: z.literal("queued") }),
    409: structuredErrorSchema,
  },
});

import { z } from "zod";
import { defineOperation } from "../operation.js";

/** How much local state a reset throws away. */
export const resetSyncBodySchema = z.object({
  scope: z.enum(["server", "full"]),
});

export const resetSync = defineOperation({
  id: "resetSync",
  method: "post",
  path: "/sync/reset",
  summary: "Reset the user's sync state",
  tags: ["sync"],
  deprecated: true,
  request: {
    body: resetSyncBodySchema,
    rejection: { error: "Invalid reset scope" },
  },
  responses: { 200: z.object({ resetToken: z.boolean() }) },
});

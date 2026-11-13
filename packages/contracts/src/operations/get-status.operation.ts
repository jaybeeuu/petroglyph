import { z } from "zod";
import { defineOperation } from "../operation.js";

/**
 * `username` is optional because the handler copies it from the JWT, and an
 * identity token that carries none yields `undefined` rather than a 500.
 */
const statusResponseSchema = z.object({
  github: z.object({ connected: z.boolean(), username: z.string().optional() }),
  oneDrive: z.object({ connected: z.boolean() }),
  oneDriveStatus: z.enum(["connected", "disconnected", "never_connected", "reconnect_required"]),
});

export const getStatus = defineOperation({
  id: "getStatus",
  method: "get",
  path: "/status",
  summary: "Report the user's sync status",
  tags: ["status"],
  responses: { 200: statusResponseSchema },
});

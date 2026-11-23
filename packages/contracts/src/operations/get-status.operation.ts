import { z } from "zod";
import { defineOperation } from "../operation.js";

/**
 * `username` is optional because the handler copies it from the JWT, and an
 * identity token that carries none yields `undefined` rather than a 500.
 *
 * `oneDriveStatus` reports the connection, and the connection is the token
 * vault row's `reconnectRequired` plus the user record's `oneDriveStatus`. No
 * profile row is read: whether the user has a profile at all is the user
 * record's own `hasProfile` mark, written by `POST /profiles` and cleared with
 * the last profile.
 *
 * - `connected`: a live connection with a profile.
 * - `connected_no_profile`: a live connection with no profile yet. The user
 *   authorised OneDrive but has not chosen a folder-to-vault mapping, which is
 *   their own action. A client prompts for a profile instead of syncing.
 * - `never_connected`: no live connection on the vault row or the user record.
 * - `reconnect_required`: the stored grant or the user record says the
 *   connection died.
 */
const statusResponseSchema = z.object({
  github: z.object({ connected: z.boolean(), username: z.string().optional() }),
  oneDrive: z.object({ connected: z.boolean() }),
  oneDriveStatus: z.enum([
    "connected",
    "connected_no_profile",
    "never_connected",
    "reconnect_required",
  ]),
});

export const getStatus = defineOperation({
  id: "getStatus",
  method: "get",
  path: "/status",
  summary: "Report the user's sync status",
  tags: ["status"],
  responses: { 200: statusResponseSchema },
});

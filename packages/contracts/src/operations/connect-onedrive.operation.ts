import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

/** The Microsoft OAuth code and state the connect flow hands back. */
export const connectOnedriveBodySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

/**
 * Establish the OneDrive connection: exchange the code, write the grant to both
 * token stores, and mark the user connected. It registers no Graph change
 * notification subscription: a subscription covers one walked root and is
 * created and deleted with the profiles that cover it, so the subscription
 * reconciler owns registration, not this step.
 *
 * It writes no sync profile row at all, not even a connection flag on an
 * existing one. Choosing which drive folder maps to which vault path is the
 * user's own profile action, so a fresh connect answers 200 and leaves the
 * profile list empty; `GET /status` then reports `connected_no_profile`.
 */
export const connectOnedrive = defineOperation({
  id: "connectOnedrive",
  method: "post",
  path: "/onedrive/connect",
  summary: "Connect an OneDrive account",
  tags: ["onedrive"],
  request: {
    body: connectOnedriveBodySchema,
    rejection: { error: "Missing required fields: code and state" },
  },
  responses: {
    200: z.object({ status: z.literal("connected") }),
    401: flatErrorSchema,
    502: flatErrorSchema,
  },
});

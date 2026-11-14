import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

/** The Microsoft OAuth code and state the connect flow hands back. */
export const connectOnedriveBodySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

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

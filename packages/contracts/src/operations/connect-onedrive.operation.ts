import { z } from "zod";
import { defineOperation } from "../operation.js";

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
});

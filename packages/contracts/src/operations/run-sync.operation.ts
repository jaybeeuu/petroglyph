import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

export const runSync = defineOperation({
  id: "runSync",
  method: "post",
  path: "/sync/run",
  summary: "Run a sync now",
  tags: ["sync"],
  deprecated: true,
  responses: {
    201: z.object({ jobId: z.string().min(1) }),
    400: flatErrorSchema,
  },
});

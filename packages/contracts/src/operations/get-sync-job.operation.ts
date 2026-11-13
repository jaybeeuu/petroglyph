import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

/** One job's progress, as the handler reports it. */
const syncJobResponseSchema = z.object({
  status: z.string().min(1),
  fileCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export const getSyncJob = defineOperation({
  id: "getSyncJob",
  method: "get",
  path: "/sync/jobs/{jobId}",
  summary: "Read one sync job",
  tags: ["sync"],
  deprecated: true,
  responses: {
    200: syncJobResponseSchema,
    404: flatErrorSchema,
  },
});

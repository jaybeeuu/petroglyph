import { defineOperation } from "../operation.js";

export const getSyncJob = defineOperation({
  id: "getSyncJob",
  method: "get",
  path: "/sync/jobs/{jobId}",
  summary: "Read one sync job",
  tags: ["sync"],
  deprecated: true,
});

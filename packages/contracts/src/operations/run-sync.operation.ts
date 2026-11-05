import { defineOperation } from "../operation.js";

export const runSync = defineOperation({
  id: "runSync",
  method: "post",
  path: "/sync/run",
  summary: "Run a sync now",
  tags: ["sync"],
  deprecated: true,
});

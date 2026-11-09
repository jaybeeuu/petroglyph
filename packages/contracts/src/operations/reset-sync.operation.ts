import { defineOperation } from "../operation.js";

export const resetSync = defineOperation({
  id: "resetSync",
  method: "post",
  path: "/sync/reset",
  summary: "Reset the user's sync state",
  tags: ["sync"],
  deprecated: true,
});

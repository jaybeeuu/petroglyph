import { defineOperation } from "../operation.js";

export const getStatus = defineOperation({
  id: "getStatus",
  method: "get",
  path: "/status",
  summary: "Report the user's sync status",
  tags: ["status"],
});

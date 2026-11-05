import { defineOperation } from "../operation.js";

export const getHealth = defineOperation({
  id: "getHealth",
  method: "get",
  path: "/health",
  summary: "Report service health",
  tags: ["health"],
});

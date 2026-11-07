import { defineOperation } from "../operation.js";

export const listFiles = defineOperation({
  id: "listFiles",
  method: "get",
  path: "/files",
  summary: "List the delivered files for the active profile",
  tags: ["files"],
});

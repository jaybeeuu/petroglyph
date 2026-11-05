import { defineOperation } from "../operation.js";

export const getFilesChanges = defineOperation({
  id: "getFilesChanges",
  method: "get",
  path: "/files/changes",
  summary: "List files changed since a cursor",
  tags: ["files"],
  deprecated: true,
});

import { defineOperation } from "../operation.js";

export const getFile = defineOperation({
  id: "getFile",
  method: "get",
  path: "/files/{itemId}",
  summary: "Read one delivered file",
  tags: ["files"],
});

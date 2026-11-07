import { defineOperation } from "../operation.js";

export const listProfiles = defineOperation({
  id: "listProfiles",
  method: "get",
  path: "/profiles",
  summary: "List sync profiles",
  tags: ["profiles"],
});

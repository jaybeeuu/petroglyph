import { defineOperation } from "../operation.js";

export const putProfile = defineOperation({
  id: "putProfile",
  method: "put",
  path: "/profiles/{id}",
  summary: "Replace one sync profile",
  tags: ["profiles"],
});

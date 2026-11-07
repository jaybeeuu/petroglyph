import { defineOperation } from "../operation.js";

export const deleteProfile = defineOperation({
  id: "deleteProfile",
  method: "delete",
  path: "/profiles/{id}",
  summary: "Delete one sync profile",
  tags: ["profiles"],
});

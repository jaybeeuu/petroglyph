import { defineOperation } from "../operation.js";

export const createProfile = defineOperation({
  id: "createProfile",
  method: "post",
  path: "/profiles",
  summary: "Create a sync profile",
  tags: ["profiles"],
});

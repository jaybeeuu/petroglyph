import { defineOperation } from "../operation.js";

export const getProfile = defineOperation({
  id: "getProfile",
  method: "get",
  path: "/profiles/{id}",
  summary: "Read one sync profile",
  tags: ["profiles"],
});

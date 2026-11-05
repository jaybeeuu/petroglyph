import { defineOperation } from "../operation.js";

export const postAuthRefresh = defineOperation({
  id: "postAuthRefresh",
  method: "post",
  path: "/auth/refresh",
  summary: "Refresh the access token",
  tags: ["auth"],
});

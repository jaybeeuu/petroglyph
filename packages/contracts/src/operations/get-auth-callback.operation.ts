import { defineOperation } from "../operation.js";

export const getAuthCallback = defineOperation({
  id: "getAuthCallback",
  method: "get",
  path: "/auth/callback",
  summary: "Complete the GitHub authorisation flow",
  tags: ["auth"],
});

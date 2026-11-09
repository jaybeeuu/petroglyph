import { defineOperation } from "../operation.js";

export const getAuthUrl = defineOperation({
  id: "getAuthUrl",
  method: "get",
  path: "/auth/url",
  summary: "Start the GitHub authorisation flow",
  tags: ["auth"],
});

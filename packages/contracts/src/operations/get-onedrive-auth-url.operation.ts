import { defineOperation } from "../operation.js";

export const getOnedriveAuthUrl = defineOperation({
  id: "getOnedriveAuthUrl",
  method: "get",
  path: "/onedrive/auth-url",
  summary: "Start the OneDrive authorisation flow",
  tags: ["onedrive"],
});

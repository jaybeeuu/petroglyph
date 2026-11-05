import { defineOperation } from "../operation.js";

export const bridgeOnedriveCallback = defineOperation({
  id: "bridgeOnedriveCallback",
  method: "get",
  path: "/onedrive/connect",
  summary: "Bridge the OneDrive OAuth callback into the app",
  tags: ["onedrive"],
});

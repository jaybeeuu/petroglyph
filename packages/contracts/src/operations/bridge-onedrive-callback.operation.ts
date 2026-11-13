import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

/**
 * Both answers are 302 redirects into the app, which carry no body; only the
 * missing-parameter rejection writes one.
 */
export const bridgeOnedriveCallback = defineOperation({
  id: "bridgeOnedriveCallback",
  method: "get",
  path: "/onedrive/connect",
  summary: "Bridge the OneDrive OAuth callback into the app",
  tags: ["onedrive"],
  responses: { 400: flatErrorSchema },
});

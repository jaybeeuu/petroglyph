import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

/**
 * The success path is a 302 to the caller's `returnUri` with no body, so it is
 * not declared: a response schema describes a body, and a redirect has none.
 */
export const getAuthCallback = defineOperation({
  id: "getAuthCallback",
  method: "get",
  path: "/auth/callback",
  summary: "Complete the GitHub authorisation flow",
  tags: ["auth"],
  responses: {
    400: flatErrorSchema,
    401: flatErrorSchema,
    502: flatErrorSchema,
  },
});

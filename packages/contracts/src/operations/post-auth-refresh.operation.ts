import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

/**
 * The refresh body is read by the handler, not by a request schema (slice 3 does
 * not restructure handlers), so only the responses are declared here.
 */
export const postAuthRefresh = defineOperation({
  id: "postAuthRefresh",
  method: "post",
  path: "/auth/refresh",
  summary: "Refresh the access token",
  tags: ["auth"],
  responses: {
    200: z.object({ jwt: z.string().min(1), refreshToken: z.string().min(1) }),
    400: flatErrorSchema,
    401: flatErrorSchema,
  },
});

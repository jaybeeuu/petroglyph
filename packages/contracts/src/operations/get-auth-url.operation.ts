import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

export const getAuthUrl = defineOperation({
  id: "getAuthUrl",
  method: "get",
  path: "/auth/url",
  summary: "Start the GitHub authorisation flow",
  tags: ["auth"],
  responses: {
    200: z.object({ url: z.string().min(1) }),
    // The route builds the query itself, so a missing `returnUri` is its own 400.
    400: flatErrorSchema,
    500: flatErrorSchema,
  },
});

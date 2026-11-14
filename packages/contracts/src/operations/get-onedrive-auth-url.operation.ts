import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

export const getOnedriveAuthUrl = defineOperation({
  id: "getOnedriveAuthUrl",
  method: "get",
  path: "/onedrive/auth-url",
  summary: "Start the OneDrive authorisation flow",
  tags: ["onedrive"],
  responses: {
    200: z.object({ url: z.string().min(1) }),
    400: flatErrorSchema,
    500: flatErrorSchema,
  },
});

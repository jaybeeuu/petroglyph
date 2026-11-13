import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";
import { syncProfileResponseSchema } from "../responses/sync-profile.js";

export const getProfile = defineOperation({
  id: "getProfile",
  method: "get",
  path: "/profiles/{id}",
  summary: "Read one sync profile",
  tags: ["profiles"],
  responses: {
    200: syncProfileResponseSchema,
    404: flatErrorSchema,
  },
});

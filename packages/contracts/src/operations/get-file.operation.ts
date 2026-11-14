import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";
import { feedEntryResponseSchema } from "../responses/feed.js";

/**
 * One delivered file, served by `packages/staging-delivery` on its own Hono
 * route; see `list-files.operation.ts` for why the schema lives here.
 */
export const getFile = defineOperation({
  id: "getFile",
  method: "get",
  path: "/files/{itemId}",
  summary: "Read one delivered file",
  tags: ["files"],
  responses: {
    200: feedEntryResponseSchema,
    404: flatErrorSchema,
  },
});

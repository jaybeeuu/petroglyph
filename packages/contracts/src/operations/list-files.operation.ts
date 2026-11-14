import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";
import { feedEntryResponseSchema } from "../responses/feed.js";

/**
 * One page of the delivered files. Served by `packages/staging-delivery`, which
 * registers its own Hono route rather than a `defineEndpoint` chain, so this
 * schema describes that route for the spec and for any wrapper that adopts it.
 */
export const listFiles = defineOperation({
  id: "listFiles",
  method: "get",
  path: "/files",
  summary: "List the delivered files for the active profile",
  tags: ["files"],
  responses: {
    200: z.object({ files: z.array(feedEntryResponseSchema), nextToken: z.string().nullable() }),
    400: flatErrorSchema,
  },
});

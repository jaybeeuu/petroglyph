import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema, structuredErrorSchema } from "../responses/error.js";
import { feedEntryResponseSchema } from "../responses/feed.js";
import { profileIdParamsSchema } from "./put-profile.operation.js";

/**
 * One page of the delivered files for one profile. Served by
 * `packages/staging-delivery`, which registers its own Hono route rather than a
 * `defineEndpoint` chain, so this schema describes that route for the spec and
 * for any wrapper that adopts it.
 *
 * The profile is named in the path: a deleted profile answers `410`, which is
 * never the same answer as an empty page.
 */
export const listFiles = defineOperation({
  id: "listFiles",
  method: "get",
  path: "/profiles/{id}/files",
  summary: "List the delivered files for a profile",
  tags: ["files"],
  request: {
    params: profileIdParamsSchema,
    rejection: { error: "Invalid profile id" },
  },
  responses: {
    200: z.object({ files: z.array(feedEntryResponseSchema), nextToken: z.string().nullable() }),
    400: flatErrorSchema,
    404: flatErrorSchema,
    410: structuredErrorSchema,
  },
});

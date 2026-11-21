import { z } from "zod";
import { defineOperation } from "../operation.js";
import { flatErrorSchema, structuredErrorSchema } from "../responses/error.js";
import { feedEntryResponseSchema } from "../responses/feed.js";

/** The profile and item `GET /profiles/{id}/files/{itemId}` names. */
export const getFileParamsSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
});

/**
 * One delivered file, served by `packages/staging-delivery` on its own Hono
 * route; see `list-files.operation.ts` for why the schema lives here.
 */
export const getFile = defineOperation({
  id: "getFile",
  method: "get",
  path: "/profiles/{id}/files/{itemId}",
  summary: "Read one delivered file",
  tags: ["files"],
  request: {
    params: getFileParamsSchema,
    rejection: { error: "Invalid file id" },
  },
  responses: {
    200: feedEntryResponseSchema,
    404: flatErrorSchema,
    410: structuredErrorSchema,
  },
});

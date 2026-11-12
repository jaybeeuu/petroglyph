import { z } from "zod";
import { defineOperation } from "../operation.js";

/** Reading `limit` from a query string means coercing it; a bound keeps it a page. */
export const MAX_FILE_CHANGES_PAGE_SIZE = 100;
const DEFAULT_FILE_CHANGES_PAGE_SIZE = 25;

/** The cursor and page size of a `GET /files/changes` request. */
export const filesChangesQuerySchema = z.object({
  after: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_FILE_CHANGES_PAGE_SIZE)
    .default(DEFAULT_FILE_CHANGES_PAGE_SIZE),
});

export const getFilesChanges = defineOperation({
  id: "getFilesChanges",
  method: "get",
  path: "/files/changes",
  summary: "List files changed since a cursor",
  tags: ["files"],
  deprecated: true,
  request: {
    query: filesChangesQuerySchema,
    rejection: { error: "Invalid files changes query" },
  },
});

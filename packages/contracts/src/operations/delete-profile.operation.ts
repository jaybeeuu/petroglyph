import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

/**
 * The handler soft-deletes the profile and answers with no body, so no success
 * schema is declared: only the 404 writes a body. A repeated delete answers 200
 * again rather than 404, because a retry must not look like a failure.
 */
export const deleteProfile = defineOperation({
  id: "deleteProfile",
  method: "delete",
  path: "/profiles/{id}",
  summary: "Delete one sync profile",
  tags: ["profiles"],
  responses: { 404: flatErrorSchema },
});

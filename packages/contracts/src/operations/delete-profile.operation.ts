import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

/**
 * The handler removes the profile and its records, then answers with no body, so
 * the 204 success is not declared: only the 404 writes a body.
 */
export const deleteProfile = defineOperation({
  id: "deleteProfile",
  method: "delete",
  path: "/profiles/{id}",
  summary: "Delete one sync profile",
  tags: ["profiles"],
  responses: { 404: flatErrorSchema },
});

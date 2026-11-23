import { defineOperation } from "../operation.js";
import { flatErrorSchema } from "../responses/error.js";

/**
 * The handler soft-deletes the profile: it sets `deletedAt` and leaves the row,
 * so a profile-scoped route can answer `410` instead of `404`. A repeat delete is
 * a no-op and succeeds the same way, so the success carries no body and no
 * schema is declared for it: only the 404 writes one.
 */
export const deleteProfile = defineOperation({
  id: "deleteProfile",
  method: "delete",
  path: "/profiles/{id}",
  summary: "Delete one sync profile",
  tags: ["profiles"],
  responses: { 404: flatErrorSchema },
});

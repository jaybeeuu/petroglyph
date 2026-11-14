import { z } from "zod";
import { defineOperation } from "../operation.js";

/**
 * Microsoft's subscription handshake: the validation token is echoed back as
 * text/plain, and the notification itself is answered 202 with no body. Only the
 * text echo carries a body, so only it is declared.
 *
 * A response schema describes a body, not a media type, and the generated spec
 * labels every declared schema `application/json`, so the spec calls this echo
 * JSON while the route answers text/plain. The schema still holds the handler to
 * the echo it actually writes.
 */
export const postOnedriveLifecycle = defineOperation({
  id: "postOnedriveLifecycle",
  method: "post",
  path: "/onedrive/lifecycle",
  summary: "Receive OneDrive lifecycle notifications",
  tags: ["onedrive"],
  responses: { 200: z.string() },
});

import { z } from "zod";

/**
 * The flat error body these routes answered with before the conventions existed:
 * `{ "error": "…" }`. Most handlers still write it, and the shared JWT middleware
 * that rejects a token emits it too, so it is the response of every 4xx and 5xx
 * a route writes itself.
 */
export const flatErrorSchema = z.object({ error: z.string() });

/**
 * The structured envelope from `docs/api-conventions.md`:
 * `{ error: { code, message, details? } }`. `code` is what a client branches on.
 */
export const structuredErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.array(z.unknown()).optional(),
  }),
});

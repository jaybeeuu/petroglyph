/** HTTP methods the API surface serves. OpenAPI operation keys are lowercase. */
export type HttpMethod = "get" | "post" | "put" | "delete";

/**
 * One operation on the API surface: its identity plus where it is served.
 * Paths use the OpenAPI parameter form (`/profiles/{id}`), never Hono's
 * `:id` form, so the registry is the one spelling every consumer shares.
 */
export interface Operation {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly deprecated?: boolean;
}

/**
 * Types an operation definition. The `const` type parameter keeps `id`, `path`
 * and `method` as literals, so later slices can derive the served surface from
 * the registry instead of re-declaring it.
 */
export function defineOperation<const Definition extends Operation>(
  definition: Definition,
): Definition {
  return definition;
}

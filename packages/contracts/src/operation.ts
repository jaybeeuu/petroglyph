import type { z } from "zod";

/** HTTP methods the API surface serves. OpenAPI operation keys are lowercase. */
export type HttpMethod = "get" | "post" | "put" | "delete";

/**
 * The body an operation answers with when its request schemas reject a request.
 * Flat `{ error }` today, matching the hand-written handlers this replaces.
 */
export interface RequestRejection {
  readonly error: string;
  /** Echo the zod issues as `details`, as the hand-written handlers did. */
  readonly includeIssues?: boolean;
}

/**
 * The zod schemas one operation validates its request with. An absent target is
 * not read from the request at all.
 */
export interface RequestSchemas {
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  readonly rejection?: RequestRejection;
}

/**
 * One operation on the API surface: its identity, where it is served, and how
 * its request is validated. Paths use the OpenAPI parameter form
 * (`/profiles/{id}`), never Hono's `:id` form, so the registry is the one
 * spelling every consumer shares.
 */
export interface Operation<Request extends RequestSchemas = RequestSchemas> {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly deprecated?: boolean;
  readonly request?: Request;
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

/** The parsed output of one request schema, or `undefined` when it is absent. */
export type SchemaOutput<Schema> = Schema extends z.ZodType<infer Output> ? Output : undefined;

/** One request target the operation reads, as `defineEndpoint` parses it. */
export type RequestTarget<
  Request extends RequestSchemas | undefined,
  Target extends keyof RequestSchemas,
> = SchemaOutput<Request extends RequestSchemas ? Request[Target] : undefined>;

/**
 * The parsed request `defineEndpoint` hands a handler. A target the operation
 * does not declare is `undefined`, so the handler cannot read it by accident.
 */
export interface EndpointInput<Request extends RequestSchemas | undefined> {
  readonly params: RequestTarget<Request, "params">;
  readonly query: RequestTarget<Request, "query">;
  readonly body: RequestTarget<Request, "body">;
}

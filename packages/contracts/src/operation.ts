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
 * The bodies one operation answers with, keyed by HTTP status. A schema judges
 * the body the handler wrote, which is how a handler that drifts from its
 * contract is caught: at runtime by `defineEndpoint`, and in the generated spec
 * by the emitter.
 *
 * Only a status that writes a body is declared. A 302 redirect and a delete that
 * answers 204 carry no body, so a schema for them would describe something the
 * handler never writes.
 */
export interface ResponseSchemas {
  readonly [status: number]: z.ZodType;
}

/**
 * One operation on the API surface: its identity, where it is served, how its
 * request is validated, and what it answers with. Paths use the OpenAPI
 * parameter form (`/profiles/{id}`), never Hono's `:id` form, so the registry is
 * the one spelling every consumer shares.
 */
export interface Operation<Request extends RequestSchemas = RequestSchemas> {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly deprecated?: boolean;
  readonly request?: Request;
  readonly responses?: ResponseSchemas;
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

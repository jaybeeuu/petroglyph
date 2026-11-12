import { zValidator } from "@hono/zod-validator";
import type { Context, Env, MiddlewareHandler } from "hono";
import type { z } from "zod";
import type { EndpointInput, Operation, RequestRejection, RequestSchemas } from "./operation.js";

/** OpenAPI spells a path parameter `{id}`; Hono spells it `:id`. */
export function toHonoPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * The signature every operation handler has: the request parsed by the
 * operation's schemas, and the Hono context for identity and status. A handler
 * never reads `c.req` to validate; validation happened before it ran.
 */
export type EndpointHandler<OperationDefinition extends Operation, HonoEnv extends Env> = (
  input: EndpointInput<OperationDefinition["request"]>,
  c: Context<HonoEnv>,
) => Response | Promise<Response>;

/** The validated-data target each request schema maps onto. */
type RequestTargetName = "param" | "query" | "json";

const REJECTION_STATUS = 400;

/** What an operation answers when it declares schemas but no rejection body. */
const DEFAULT_REJECTION: RequestRejection = { error: "Invalid request" };

/**
 * Binds an operation to its handler. The returned middleware validates every
 * declared request target with the operation's zod schema, answers 400 with the
 * operation's rejection body when one fails, and then calls the handler with the
 * parsed request.
 *
 * The result is a handler chain, not a single handler, because each target needs
 * its own validator. Register it by naming the first middleware, so Hono's
 * handler-tuple overloads match a chain whose length varies with the operation:
 * `const [first, ...rest] = defineEndpoint(op, handler); app.on(method, path, first, ...rest)`.
 */
export function defineEndpoint<OperationDefinition extends Operation, HonoEnv extends Env>(
  operation: OperationDefinition,
  handler: EndpointHandler<OperationDefinition, HonoEnv>,
): MiddlewareHandler<HonoEnv>[] {
  const request: RequestSchemas | undefined = operation.request;
  const rejection = request?.rejection ?? DEFAULT_REJECTION;
  const endpoint: MiddlewareHandler<HonoEnv>[] = [];

  if (request?.params !== undefined) {
    endpoint.push(validate("param", request.params, rejection));
  }
  if (request?.query !== undefined) {
    endpoint.push(validate("query", request.query, rejection));
  }
  if (request?.body !== undefined) {
    endpoint.push(validate("json", request.body, rejection));
  }

  endpoint.push(async (c) => {
    const input = readInput(c, request);
    return handler(input as EndpointInput<OperationDefinition["request"]>, c);
  });

  return endpoint;
}

/**
 * One operation request schema as middleware. The cast is the price of keeping
 * this module generic: `zValidator` cannot infer the environment from a schema.
 */
function validate<HonoEnv extends Env>(
  target: RequestTargetName,
  schema: z.ZodType,
  rejection: RequestRejection,
): MiddlewareHandler<HonoEnv> {
  const validator = zValidator(target, schema, (result, c) => {
    if (result.success) {
      return;
    }
    return reject(c, rejection, result.error.issues);
  });
  return validator as unknown as MiddlewareHandler<HonoEnv>;
}

/** Reads a target the validator above stored on the request. */
function readInput<HonoEnv extends Env>(
  c: Context<HonoEnv>,
  request: RequestSchemas | undefined,
): EndpointInput<RequestSchemas> {
  return {
    params: request?.params === undefined ? undefined : readValidated(c, "param"),
    query: request?.query === undefined ? undefined : readValidated(c, "query"),
    body: request?.body === undefined ? undefined : readValidated(c, "json"),
  };
}

/**
 * `HonoRequest.valid` is typed against the validators in the route's chain, which
 * a generic wrapper cannot name. The target names above are the ones this module
 * registered, so the lookup is well defined at runtime.
 */
function readValidated(c: Context, target: RequestTargetName): unknown {
  const request = c.req as unknown as { valid: (name: RequestTargetName) => unknown };
  return request.valid(target);
}

/** The operation's own 400 body, so a rejected request reads as it always did. */
function reject<HonoEnv extends Env>(
  c: Context<HonoEnv>,
  rejection: RequestRejection,
  issues: readonly unknown[],
): Response {
  const body =
    rejection.includeIssues === true
      ? { error: rejection.error, details: issues }
      : { error: rejection.error };
  return c.json(body, REJECTION_STATUS);
}

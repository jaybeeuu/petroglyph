import type { Operation } from "./operation.js";

/** What a response that violates its operation's schema is allowed to do. */
export type ResponseValidationMode = "report" | "log";

/** The environment fields the policy reads, so a test can supply its own. */
export interface ResponseValidationEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly AWS_LAMBDA_FUNCTION_NAME?: string | undefined;
}

const MISMATCH_CODE = "response_contract_mismatch";
const INTERNAL_SERVER_ERROR = 500;

/**
 * THE POLICY, stated once. A response that violates the schema its operation
 * declares is a bug in the handler, and the two environments want opposite
 * answers to it:
 *
 * - `report` — tests, and every environment that is not a deployed runtime. The
 *   route answers 500 carrying the operation, the status and the zod issues, so
 *   the bug fails the run that caused it instead of shipping.
 * - `log` — the deployed runtime. The mismatch is logged with the same detail
 *   and the handler's response goes out untouched: a contract breach must never
 *   turn a working request into a 500 for a user.
 *
 * This function is the only place that reads the environment; every endpoint
 * resolves its mode through it, and a caller may pass a mode explicitly (tests
 * do) to exercise the other branch.
 */
export function responseValidationMode(
  env: ResponseValidationEnvironment = process.env,
): ResponseValidationMode {
  return isDeployed(env) ? "log" : "report";
}

/**
 * A deployed runtime is one where a user's request is at stake, and it is
 * recognised two ways because one is not enough here. `NODE_ENV === "production"`
 * is the ordinary signal; but the deployed API function sets no `NODE_ENV` (see
 * `packages/infra/lambda_api.tf`, which passes only resource names), so the
 * Lambda runtime's own `AWS_LAMBDA_FUNCTION_NAME` is the signal that actually
 * holds in production. Reading only `NODE_ENV` would report — and so 500 — in
 * production, the one outcome this policy exists to prevent. A preview or
 * staging function therefore logs as well; `pnpm test` is where a mismatch is
 * reported.
 */
function isDeployed(env: ResponseValidationEnvironment): boolean {
  return env.NODE_ENV === "production" || env.AWS_LAMBDA_FUNCTION_NAME !== undefined;
}

/**
 * Holds one response to the schema its operation declares for that status, and
 * answers what the mode says to answer. A status the operation does not declare
 * is never read: the body stays unread and no work is spent on it.
 */
export async function validateResponse(
  operation: Operation,
  response: Response,
  mode: ResponseValidationMode,
): Promise<Response> {
  const schema = operation.responses?.[response.status];
  if (schema === undefined) {
    return response;
  }
  const parsed = await schema.safeParseAsync(await readBody(response));
  if (parsed.success) {
    return response;
  }
  console.error("[contracts] Response violates the schema its operation declares", {
    operationId: operation.id,
    status: response.status,
    issues: parsed.error.issues,
  });
  return mode === "log"
    ? response
    : mismatchResponse(operation, response.status, parsed.error.issues);
}

/** A body a client reads back: JSON when the response is JSON, text otherwise. */
async function readBody(response: Response): Promise<unknown> {
  const copy = response.clone();
  try {
    if ((copy.headers.get("content-type") ?? "").includes("application/json")) {
      return await copy.json();
    }
    const text = await copy.text();
    return text === "" ? undefined : text;
  } catch {
    // A body that will not parse is a mismatch, not a second failure to report.
    return undefined;
  }
}

/**
 * What `report` mode answers instead of the drifted response: the documented
 * error envelope, with the mismatch as its `details`.
 */
function mismatchResponse(
  operation: Operation,
  status: number,
  issues: readonly unknown[],
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: MISMATCH_CODE,
        message: `Operation "${operation.id}" answered ${String(status)} with a body that violates its response schema`,
        details: issues,
      },
    }),
    {
      status: INTERNAL_SERVER_ERROR,
      headers: { "Content-Type": "application/json" },
    },
  );
}

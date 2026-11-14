import type { Operation, ResponseSchemas } from "./operation.js";
import { flatErrorSchema } from "./responses/error.js";

/** A route served without the shared identity middleware, in registry spelling. */
export interface UnauthenticatedRoute {
  readonly method: string;
  readonly path: string;
}

/**
 * Every route the shared JWT middleware does not guard, stated once. The api app
 * skips its guard for exactly these routes, and the registry derives which
 * operations answer 401 from the same list, so the guard and the contract cannot
 * drift apart.
 */
export const UNAUTHENTICATED_ROUTES: readonly UnauthenticatedRoute[] = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/auth/url" },
  { method: "GET", path: "/auth/callback" },
  { method: "POST", path: "/auth/refresh" },
  { method: "POST", path: "/onedrive/lifecycle" },
  { method: "GET", path: "/onedrive/connect" },
];

/** Whether the shared guard leaves this operation's route open to unauthenticated callers. */
export function isUnauthenticated(operation: Operation): boolean {
  const method = operation.method.toUpperCase();
  return UNAUTHENTICATED_ROUTES.some(
    (route) => route.method === method && route.path === operation.path,
  );
}

/**
 * The operation with the 401 its guard answers declared. The middleware writes a
 * flat `{ error: "UNAUTHORIZED" }`, so the declaration is `flatErrorSchema`: a
 * structured 401 would report a mismatch on every unauthenticated request in
 * `report` mode.
 */
export function withUnauthorized<const Definition extends Operation>(
  operation: Definition,
): Omit<Definition, "responses"> & { readonly responses: ResponseSchemas } {
  return { ...operation, responses: { ...operation.responses, 401: flatErrorSchema } };
}

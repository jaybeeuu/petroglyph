import type { Operation } from "./operation.js";

/** A route registration as Hono's `app.routes` reports it: uppercased method. */
export interface ServedRoute {
  readonly method: string;
  readonly path: string;
}

/** Anything with a readable route table: a Hono app or a router mounted into one. */
export interface RouteTable {
  readonly routes: readonly ServedRoute[];
}

/** The two directions in which the served surface can drift from the registry. */
export interface SurfaceDiff {
  /** Served by an app but missing from the registry. */
  readonly undeclared: readonly string[];
  /** Declared in the registry but served by no app. */
  readonly unserved: readonly string[];
}

/** Methods that answer a request; Hono's `ALL` marks middleware, not an operation. */
const SERVED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Hono spells a path parameter `:id`, the registry spells it `{id}`. */
function normalisePath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

function isOperationRoute(route: ServedRoute): boolean {
  return SERVED_METHODS.has(route.method) && !route.path.includes("*");
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Every route the apps serve, as `METHOD /path` in registry spelling. Middleware
 * and wildcard registrations are dropped: they guard a path, they do not serve one.
 */
export function collectServedSurface(apps: readonly RouteTable[]): readonly string[] {
  const keys = new Set<string>();
  for (const app of apps) {
    for (const route of app.routes) {
      if (isOperationRoute(route)) {
        keys.add(routeKey(route.method, normalisePath(route.path)));
      }
    }
  }
  return [...keys].sort();
}

/** The registry in the spelling `collectServedSurface` produces. */
export function collectRegistrySurface(operations: readonly Operation[]): readonly string[] {
  return operations.map((operation) => routeKey(operation.method, operation.path)).sort();
}

/**
 * Compares the two surfaces in both directions, so one assertion names every
 * route that was added to an app without a registry entry and every registry
 * entry no app serves.
 */
export function compareSurface(
  served: readonly string[],
  registered: readonly string[],
): SurfaceDiff {
  const servedKeys = new Set(served);
  const registeredKeys = new Set(registered);
  return {
    undeclared: served.filter((key) => !registeredKeys.has(key)),
    unserved: registered.filter((key) => !servedKeys.has(key)),
  };
}

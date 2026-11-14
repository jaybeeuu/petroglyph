import { describe, expect, it } from "vitest";
import { isUnauthenticated, UNAUTHENTICATED_ROUTES } from "../src/authentication.js";
import type { Operation, ResponseSchemas } from "../src/operation.js";
import { operationList } from "../src/operations/index.js";
import { flatErrorSchema } from "../src/responses/error.js";

const routeKey = (method: string, path: string): string => `${method} ${path}`;

/** An operation's declared bodies, however narrow the entry's own response type is. */
function declarations(operation: Operation): ResponseSchemas | undefined {
  return operation.responses;
}

/** The operations the shared guard protects, derived from the one list of exemptions. */
function guardedOperations(): readonly Operation[] {
  return operationList.filter((operation) => !isUnauthenticated(operation));
}

describe("declared guard rejections", () => {
  it("declares a flat 401 on every operation the shared guard protects", () => {
    const undeclared = guardedOperations()
      .filter((operation) => declarations(operation)?.[401] !== flatErrorSchema)
      .map((operation) => operation.id);

    expect(undeclared).toStrictEqual([]);
  });

  it("names only routes the registry actually serves", () => {
    const served = new Set(
      operationList.map((operation) => routeKey(operation.method.toUpperCase(), operation.path)),
    );

    const unknown = UNAUTHENTICATED_ROUTES.map((route) =>
      routeKey(route.method, route.path),
    ).filter((route) => !served.has(route));

    expect(unknown).toStrictEqual([]);
  });

  it("leaves the health route open, so liveness is answered without a token", () => {
    expect(guardedOperations().map((operation) => operation.id)).not.toContain("getHealth");
  });
});

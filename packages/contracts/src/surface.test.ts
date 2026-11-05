import { describe, expect, it } from "vitest";
import type { Operation } from "./operation.js";
import { collectRegistrySurface, collectServedSurface, compareSurface } from "./surface.js";

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "getThing",
    method: "get",
    path: "/things/{thingId}",
    summary: "Read one thing",
    tags: ["things"],
    ...overrides,
  };
}

describe("collectServedSurface", () => {
  it("spells a Hono path parameter the way the registry does", () => {
    const served = collectServedSurface([
      { routes: [{ method: "GET", path: "/things/:thingId" }] },
    ]);

    expect(served).toStrictEqual(["GET /things/{thingId}"]);
  });

  it("drops middleware and wildcard registrations, which serve no operation", () => {
    const served = collectServedSurface([
      {
        routes: [
          { method: "ALL", path: "/*" },
          { method: "ALL", path: "/things/*" },
          { method: "GET", path: "/things" },
        ],
      },
    ]);

    expect(served).toStrictEqual(["GET /things"]);
  });

  it("merges every app into one sorted surface", () => {
    const served = collectServedSurface([
      { routes: [{ method: "GET", path: "/profiles" }] },
      { routes: [{ method: "GET", path: "/files" }] },
    ]);

    expect(served).toStrictEqual(["GET /files", "GET /profiles"]);
  });
});

describe("collectRegistrySurface", () => {
  it("spells each operation as method and path", () => {
    const registered = collectRegistrySurface([
      operation({ id: "deleteThing", method: "delete", path: "/things/{thingId}" }),
      operation({ id: "listThings", method: "get", path: "/things" }),
    ]);

    expect(registered).toStrictEqual(["DELETE /things/{thingId}", "GET /things"]);
  });
});

describe("compareSurface", () => {
  it("reports a route served with no registry entry", () => {
    const diff = compareSurface(["GET /things", "POST /things"], ["GET /things"]);

    expect(diff).toStrictEqual({ undeclared: ["POST /things"], unserved: [] });
  });

  it("reports a registry entry no app serves", () => {
    const diff = compareSurface(["GET /things"], ["GET /things", "DELETE /things/{thingId}"]);

    expect(diff).toStrictEqual({ undeclared: [], unserved: ["DELETE /things/{thingId}"] });
  });

  it("reports nothing when the two surfaces agree", () => {
    const diff = compareSurface(["GET /things"], ["GET /things"]);

    expect(diff).toStrictEqual({ undeclared: [], unserved: [] });
  });
});

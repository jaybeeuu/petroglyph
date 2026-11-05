import { describe, expect, it } from "vitest";
import { app as apiApp } from "../../api/src/app.js";
import { createFilesRouter, type FilesRouterDependencies } from "../../staging-delivery/src/app.js";
import { createApp as createStagingDeliveryApp } from "../../staging-delivery/src/index.js";
import { operationList } from "../src/operations/index.js";
import { collectRegistrySurface, collectServedSurface, compareSurface } from "../src/surface.js";

/**
 * Why this test imports two sibling packages by path: the registry is the only
 * declaration of the API surface, and it is only worth anything if it is held to
 * the routes the apps actually register. The three Hono apps live in `api` and
 * `staging-delivery`; neither builds an entry point a test could import, so their
 * app sources are reached directly. `api` serves everything but `/files`, which
 * is served by `staging-delivery` — the split that hid `/files` from the
 * hand-written spec.
 */

/** The router's stores are never reached: this test reads route tables, not records. */
function unreachable(): Promise<never> {
  return Promise.reject(new Error("The parity test reads routes; it never serves a request."));
}

function createFilesRouterSurface(): ReturnType<typeof createFilesRouter> {
  const dependencies: FilesRouterDependencies = {
    index: {
      upsert: unreachable,
      get: unreachable,
      remove: unreachable,
      listUnderPath: unreachable,
      removeUnderPath: unreachable,
      queryFeed: unreachable,
    },
    objectStore: {
      put: unreachable,
      get: unreachable,
      delete: unreachable,
      presignGet: unreachable,
    },
    listProfiles: unreachable,
  };
  return createFilesRouter(dependencies);
}

function createStagingDeliverySurface(): ReturnType<typeof createStagingDeliveryApp> {
  process.env["STAGED_PDFS_BUCKET"] ??= "parity-test";
  return createStagingDeliveryApp();
}

describe("API surface parity", () => {
  it("serves exactly the routes the registry declares, in both directions", () => {
    const served = collectServedSurface([
      apiApp,
      createFilesRouterSurface(),
      createStagingDeliverySurface(),
    ]);
    const registered = collectRegistrySurface(operationList);

    expect(compareSurface(served, registered)).toStrictEqual({ undeclared: [], unserved: [] });
  });
});

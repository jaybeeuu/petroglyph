import { toHonoPath } from "@petroglyph/contracts/hono";
import { operationList, type OperationId } from "@petroglyph/contracts/operations";
import type { Hono, MiddlewareHandler } from "hono";
import { getAuthCallbackEndpoint } from "./auth-callback.js";
import { postAuthRefreshEndpoint } from "./auth-refresh.js";
import type { AppVariables } from "./auth-middleware.js";
import { getAuthUrlEndpoint } from "./auth-url.js";
import { getFilesChangesEndpoint } from "./files-changes.js";
import { getHealthEndpoint } from "./health.js";
import { bridgeOnedriveCallbackEndpoint, connectOnedriveEndpoint } from "./onedrive-connect.js";
import { getOnedriveAuthUrlEndpoint } from "./onedrive-auth-url.js";
import { postOnedriveLifecycleEndpoint } from "./onedrive-lifecycle.js";
import { createProfileEndpoint, listProfilesEndpoint } from "./profiles.js";
import { deleteProfileEndpoint, getProfileEndpoint, putProfileEndpoint } from "./profiles-crud.js";
import { getStatusEndpoint } from "./status.js";
import { getSyncJobEndpoint } from "./sync-jobs.js";
import { resetSyncEndpoint } from "./sync-reset.js";
import { runSyncEndpoint } from "./sync-run.js";
import { createSyncTriggerEndpoint, type SyncTriggerDeps } from "./sync-trigger.js";

/** One operation's handler chain: the request validators, then the handler. */
export type ApiEndpoint = MiddlewareHandler<{ Variables: AppVariables }>[];

/** The two operations packages/staging-delivery serves on the same surface. */
type DeliveryOperationId = "listFiles" | "getFile";

/** Every operation this app serves, derived from the registry, never widened. */
export type ApiOperationId = Exclude<OperationId, DeliveryOperationId>;

/**
 * One handler chain per operation. Mapping over the union makes a missing
 * operation a compile error, which is the guarantee the registry buys.
 */
export type ApiHandlers = { [Operation in ApiOperationId]: ApiEndpoint };

function isApiOperationId(id: OperationId): id is ApiOperationId {
  return id !== "listFiles" && id !== "getFile";
}

/**
 * Every operation this app serves, bound to its handler. The Record is
 * exhaustive over `ApiOperationId`, so an operation added to the registry
 * without a handler is a compile error rather than a route served by accident
 * through some other registration.
 */
export function createHandlers(syncTriggerDeps: SyncTriggerDeps): ApiHandlers {
  return {
    getHealth: getHealthEndpoint,
    getAuthUrl: getAuthUrlEndpoint,
    getAuthCallback: getAuthCallbackEndpoint,
    postAuthRefresh: postAuthRefreshEndpoint,
    getStatus: getStatusEndpoint,
    getFilesChanges: getFilesChangesEndpoint,
    listProfiles: listProfilesEndpoint,
    createProfile: createProfileEndpoint,
    getProfile: getProfileEndpoint,
    putProfile: putProfileEndpoint,
    deleteProfile: deleteProfileEndpoint,
    getOnedriveAuthUrl: getOnedriveAuthUrlEndpoint,
    bridgeOnedriveCallback: bridgeOnedriveCallbackEndpoint,
    connectOnedrive: connectOnedriveEndpoint,
    postOnedriveLifecycle: postOnedriveLifecycleEndpoint,
    postOnedriveSyncTrigger: createSyncTriggerEndpoint(syncTriggerDeps),
    runSync: runSyncEndpoint,
    resetSync: resetSyncEndpoint,
    getSyncJob: getSyncJobEndpoint,
  };
}

/**
 * Registers every operation this app serves from the registry. Nothing else may
 * call `app.<method>`: a route registered outside this loop would be served with
 * no contract entry, which is the drift the parity test exists to catch.
 */
export function registerRoutes(
  app: Hono<{ Variables: AppVariables }>,
  handlers: ApiHandlers,
): void {
  for (const operation of operationList) {
    if (!isApiOperationId(operation.id)) {
      continue;
    }
    // The first middleware is named so Hono's handler-tuple overloads match a
    // chain whose length varies with the operation's request schemas.
    const [first, ...rest] = handlers[operation.id];
    if (first === undefined) {
      throw new Error(`Operation "${operation.id}" has no handler`);
    }
    app.on(operation.method.toUpperCase(), toHonoPath(operation.path), first, ...rest);
  }
}

import { getHealth } from "./get-health.operation.js";
import { getAuthUrl } from "./get-auth-url.operation.js";
import { getAuthCallback } from "./get-auth-callback.operation.js";
import { postAuthRefresh } from "./post-auth-refresh.operation.js";
import { getStatus } from "./get-status.operation.js";
import { getFilesChanges } from "./get-files-changes.operation.js";
import { listProfiles } from "./list-profiles.operation.js";
import { createProfile } from "./create-profile.operation.js";
import { getProfile } from "./get-profile.operation.js";
import { putProfile } from "./put-profile.operation.js";
import { deleteProfile } from "./delete-profile.operation.js";
import { getOnedriveAuthUrl } from "./get-onedrive-auth-url.operation.js";
import { bridgeOnedriveCallback } from "./bridge-onedrive-callback.operation.js";
import { connectOnedrive } from "./connect-onedrive.operation.js";
import { postOnedriveLifecycle } from "./post-onedrive-lifecycle.operation.js";
import { postOnedriveSyncTrigger } from "./post-onedrive-sync-trigger.operation.js";
import { runSync } from "./run-sync.operation.js";
import { resetSync } from "./reset-sync.operation.js";
import { getSyncJob } from "./get-sync-job.operation.js";
import { listFiles } from "./list-files.operation.js";
import { getFile } from "./get-file.operation.js";
import { defineRegistry } from "../registry.js";
import { withUnauthorized } from "../authentication.js";

/**
 * Every operation, re-exported by name so a handler imports the one it binds
 * without reaching into the registry object.
 */
export {
  getHealth,
  getAuthUrl,
  getAuthCallback,
  postAuthRefresh,
  getStatus,
  getFilesChanges,
  listProfiles,
  createProfile,
  getProfile,
  putProfile,
  deleteProfile,
  getOnedriveAuthUrl,
  bridgeOnedriveCallback,
  connectOnedrive,
  postOnedriveLifecycle,
  postOnedriveSyncTrigger,
  runSync,
  resetSync,
  getSyncJob,
  listFiles,
  getFile,
};

/**
 * Every operation the API serves, keyed by operationId. The parity test holds
 * this registry to the routes the Hono apps actually register, in both
 * directions, so a route without an entry and an entry without a route both
 * fail CI.
 *
 * An operation the shared JWT middleware guards is wrapped in `withUnauthorized`,
 * which declares the 401 that middleware answers; an operation named in
 * `UNAUTHENTICATED_ROUTES` is not, and the route the guard skips and the missing
 * declaration are the same fact. `test/authentication.test.ts` derives the
 * guarded set from that list and holds every entry to it.
 */
export const operations = defineRegistry({
  getHealth,
  getAuthUrl,
  getAuthCallback,
  postAuthRefresh,
  postOnedriveLifecycle,
  bridgeOnedriveCallback,
  getStatus: withUnauthorized(getStatus),
  getFilesChanges: withUnauthorized(getFilesChanges),
  listProfiles: withUnauthorized(listProfiles),
  createProfile: withUnauthorized(createProfile),
  getProfile: withUnauthorized(getProfile),
  putProfile: withUnauthorized(putProfile),
  deleteProfile: withUnauthorized(deleteProfile),
  getOnedriveAuthUrl: withUnauthorized(getOnedriveAuthUrl),
  connectOnedrive: withUnauthorized(connectOnedrive),
  postOnedriveSyncTrigger: withUnauthorized(postOnedriveSyncTrigger),
  runSync: withUnauthorized(runSync),
  resetSync: withUnauthorized(resetSync),
  getSyncJob: withUnauthorized(getSyncJob),
  listFiles: withUnauthorized(listFiles),
  getFile: withUnauthorized(getFile),
});

/** Every registered operationId — derived from the registry, never widened. */
export type OperationId = keyof typeof operations;

/** The registered operations as a list, in registration order. */
export const operationList = Object.values(operations);

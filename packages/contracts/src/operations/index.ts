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
import { runSync } from "./run-sync.operation.js";
import { resetSync } from "./reset-sync.operation.js";
import { getSyncJob } from "./get-sync-job.operation.js";
import { listFiles } from "./list-files.operation.js";
import { getFile } from "./get-file.operation.js";
import { defineRegistry } from "../registry.js";

/**
 * Every operation the API serves, keyed by operationId. The parity test holds
 * this registry to the routes the Hono apps actually register, in both
 * directions, so a route without an entry and an entry without a route both
 * fail CI.
 */
export const operations = defineRegistry({
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
  runSync,
  resetSync,
  getSyncJob,
  listFiles,
  getFile,
});

/** Every registered operationId — derived from the registry, never widened. */
export type OperationId = keyof typeof operations;

/** The registered operations as a list, in registration order. */
export const operationList = Object.values(operations);

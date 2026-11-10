import { defineOperation } from "../operation.js";

/**
 * Sync Now: enqueue one delta bell for the caller's OneDrive connection and
 * return 202. The plugin then polls `GET /files` as it already does, so this
 * route has no job record and no status to poll.
 *
 * Slice 2 of the contracts package must extend `Operation` with `request` and
 * `responses`, and this module must then declare them:
 * - request: no body, no parameters; authentication is the shared JWT
 *   middleware, so `userId` comes from the token and never from the request;
 * - 202 `{ status: "queued" }` (the bell is enqueued);
 * - 409 `no_connection` (onboarding never stored a connection) and 409
 *   `reconnect_required` (the grant is dead), in the shared error envelope
 *   from `docs/api-conventions.md`;
 * - 401 `unauthorized` from the middleware, which every operation shares.
 * Until then this operation carries only its path, which is all the registry
 * and the generated spec can express today.
 */
export const postOnedriveSyncTrigger = defineOperation({
  id: "postOnedriveSyncTrigger",
  method: "post",
  path: "/onedrive/sync-trigger",
  summary: "Enqueue a OneDrive delta walk for the caller's connection (Sync Now)",
  tags: ["onedrive"],
});

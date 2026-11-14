import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { createDeltaTriggerSend, type DeltaTrigger } from "@petroglyph/contracts";
import { defineEndpoint } from "@petroglyph/contracts/hono";
import { postOnedriveSyncTrigger } from "@petroglyph/contracts/operations";
import type { TokenRecord } from "@petroglyph/core";
import type { MiddlewareHandler } from "hono";
import type { AppContext, AppVariables } from "./auth-middleware.js";
import { sqsClient } from "./sqs.js";
import { docClient } from "./db.js";
import { ONEDRIVE_PROVIDER, readConnection } from "./token-vault.js";

/** The caller's stored connection, or null when onboarding never completed. */
export type ConnectionReader = (userId: string, provider: string) => Promise<TokenRecord | null>;

/** Publishes one bell; the queue's address and FIFO ids stay behind it. */
export type DeltaTriggerEnqueuer = (bell: DeltaTrigger) => Promise<void>;

/** What Sync Now needs to serve a request. It must never widen to a token client. */
export interface SyncTriggerDeps {
  readonly readConnection: ConnectionReader;
  readonly enqueueDeltaTrigger: DeltaTriggerEnqueuer;
}

/** A one-line human-readable error envelope entry, per `docs/api-conventions.md`. */
function error(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/**
 * Sync Now: enqueue one delta bell for the caller's OneDrive connection and
 * answer 202. The walk belongs to the adapter, so this handler never resolves
 * an access token and never calls Graph — it reads the connection state and
 * hands the bell to the queue. The plugin polls `GET /files` afterwards, which
 * is why there is no job record here.
 */
export function createSyncTriggerEndpoint(
  deps: SyncTriggerDeps,
): MiddlewareHandler<{ Variables: AppVariables }>[] {
  return defineEndpoint(postOnedriveSyncTrigger, async (_input, c: AppContext) => {
    const userId = c.get("userId");
    const connection = await deps.readConnection(userId, ONEDRIVE_PROVIDER);
    if (connection === null) {
      return c.json(
        error(
          "no_connection",
          "No OneDrive connection is stored for this user. Finish onboarding to connect OneDrive.",
        ),
        409,
      );
    }
    if (connection.reconnectRequired) {
      return c.json(
        error(
          "reconnect_required",
          "This OneDrive connection can no longer be used. Reconnect OneDrive to restore sync.",
        ),
        409,
      );
    }
    await deps.enqueueDeltaTrigger({ userId, provider: ONEDRIVE_PROVIDER });
    return c.json({ status: "queued" }, 202);
  });
}

/** The delta-trigger queue's address, resolved per send so no import needs env. */
export function deltaTriggerQueueUrl(): string {
  const value = process.env["DELTA_TRIGGER_QUEUE_URL"];
  if (value === undefined || value === "") {
    throw new Error("Missing required environment variable: DELTA_TRIGGER_QUEUE_URL");
  }
  return value;
}

/**
 * The deployed enqueue path: one bell onto the delta-trigger FIFO queue. The
 * queue URL is resolved per send so importing any module here stays free of
 * configuration.
 */
export function createSyncTriggerEnqueuer(
  sqs: SQSClient,
  resolveQueueUrl: () => string,
): DeltaTriggerEnqueuer {
  return async (bell) => {
    await sqs.send(
      new SendMessageCommand(
        createDeltaTriggerSend({
          queueUrl: resolveQueueUrl(),
          bell,
          // A connection's Sync Now is one delivery: a double click inside SQS's
          // five-minute window collapses instead of walking the drive twice.
          dedupeIdentity: `${bell.userId}:${bell.provider}`,
        }),
      ),
    );
  };
}

/** The deployed dependencies, built on first app construction. */
export function createSyncTriggerDeps(): SyncTriggerDeps {
  return {
    readConnection: (userId, provider) => readConnection(docClient(), userId, provider),
    enqueueDeltaTrigger: createSyncTriggerEnqueuer(sqsClient(), deltaTriggerQueueUrl),
  };
}

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DeltaTrigger } from "./delta-trigger.js";
import { DynamoDBTokenStore } from "./tokens/token-store-ddb.js";

/**
 * SQS keeps a deduplication id for five minutes from the send, and no longer.
 * The dedupe id below buckets on this window, aligned to the epoch, so the real
 * collapse guarantee is shorter than five minutes: a retry collapses only while
 * it stays inside the same bucket. A retry that crosses a bucket boundary
 * re-bells, which costs one no-op walk because the stored deltaLink is unchanged.
 */
export const DEDUPE_WINDOW_SECONDS = 5 * 60;

/** A stored connection, as the catch-up sweep needs to see it. */
export interface Connection {
  userId: string;
  provider: string;
  reconnectRequired: boolean;
}

/** The exact message the sweep asks to be published, so the transport stays dumb. */
export interface CatchUpBell {
  bell: DeltaTrigger;
  /** FIFO group: one group per connection, so its bells stay ordered. */
  messageGroupId: string;
  dedupeId: string;
}

export interface CatchUpDeps {
  listConnections: () => Promise<Connection[]>;
  enqueue: (message: CatchUpBell) => Promise<void>;
  now: () => number;
}

/**
 * The scheduled catch-up sweep: every healthy connection gets one bell, so the
 * delta walk runs even when no webhook arrives (Graph may never deliver one).
 * A connection awaiting reauthorisation is skipped — no walk can succeed until
 * a human reconnects it. An enqueue failure fails the whole invocation so the
 * scheduler retries.
 *
 * The dedupe bucket is aligned to the epoch, not to the first send, so a retry
 * collapses only before the next boundary. The test pins that behaviour.
 */
export function createCatchUpHandler(deps: CatchUpDeps): () => Promise<void> {
  return async () => {
    const bucket = Math.floor(deps.now() / (DEDUPE_WINDOW_SECONDS * 1000));
    const connections = await deps.listConnections();
    for (const connection of connections) {
      if (connection.reconnectRequired) continue;
      const bell: DeltaTrigger = { userId: connection.userId, provider: connection.provider };
      const connectionKey = `${connection.userId}:${connection.provider}`;
      await deps.enqueue({
        bell,
        messageGroupId: connectionKey,
        dedupeId: `${connectionKey}:${bucket}`,
      });
    }
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const handler = (): Promise<void> => {
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const sqsClient = new SQSClient({});
  const queueUrl = requiredEnv("DELTA_TRIGGER_QUEUE_URL");

  return createCatchUpHandler({
    listConnections: () =>
      new DynamoDBTokenStore({
        client: docClient,
        tableName: requiredEnv("REFRESH_TOKENS_TABLE"),
      }).list(),
    enqueue: async (message) => {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message.bell),
          MessageGroupId: message.messageGroupId,
          MessageDeduplicationId: message.dedupeId,
        }),
      );
    },
    now: () => Date.now(),
  })();
};

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { z } from "zod";
import { OAuthTokenResolver, listProfiles } from "@petroglyph/core";
import { DynamoDBEventLogWriter } from "@petroglyph/events";
import { S3StagedObjectStore } from "@petroglyph/staging-contracts";
import { DynamoDBTokenStore } from "./tokens/token-store-ddb.js";
import { OAuthTokenClient } from "./tokens/token-client.js";
import { MicrosoftGraphClient } from "./tokens/graph-client.js";
import { createDeltaStateStoreDdb } from "./delta/delta-state-store-ddb.js";
import { runDeltaSync, type DeltaSyncResult } from "./adapter/sync.js";

const deltaTriggerSchema = z.object({
  userId: z.string().min(1),
  provider: z.string().min(1),
});

export type DeltaTrigger = z.infer<typeof deltaTriggerSchema>;

/**
 * The 6ra adapter lambda shell: one bell/Sync-Now message per connection →
 * resolve tokens → walk the delta → fetch+gate+land → emit to the event
 * log. Trigger messages are per-connection (FIFO MessageGroupId = the
 * connection key); racing bells collapse via FIFO dedupe at the enqueuer.
 * A failed walk or throw fails the message (SQS redelivers); an
 * unparseable trigger is poison — logged loudly, never retried.
 */
export function createAdapterHandler(deps: {
  runDelta: (connection: { userId: string; provider: string }) => Promise<DeltaSyncResult>;
  log?: (message: string) => void;
}): (event: SQSEvent) => Promise<SQSBatchResponse> {
  const log = deps.log ?? console.error;
  return async (event) => {
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
    for (const message of event.Records) {
      let body: unknown;
      try {
        body = JSON.parse(message.body);
      } catch {
        log(`[adapter] invalid delta trigger (${message.body.slice(0, 120)}...): invalid JSON`);
        continue;
      }
      const parsed = deltaTriggerSchema.safeParse(body);
      if (!parsed.success) {
        log(
          `[adapter] invalid delta trigger (${message.body.slice(0, 120)}...): ${parsed.error.message}`,
        );
        continue;
      }
      try {
        const result = await deps.runDelta(parsed.data);
        if (result.outcome === "failed") {
          batchItemFailures.push({ itemIdentifier: message.messageId });
        }
      } catch (error) {
        log(`[adapter] delta run failed: ${String(error)}`);
        batchItemFailures.push({ itemIdentifier: message.messageId });
      }
    }
    return { batchItemFailures };
  };
}

const ssmClient = new SSMClient({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

async function readSsmParameter(path: string): Promise<string> {
  const result = await ssmClient.send(new GetParameterCommand({ Name: path }));
  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter not found: ${path}`);
  }
  return value;
}

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Required configuration fails loudly at composition time — a missing table or
 * bucket names itself in the Error instead of silently defaulting to a table
 * whose key schema cannot serve the adapter's queries (petroglyph-j1gn.22).
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const DEFAULT_DRIVE_ROOT_DELTA_URL =
  "https://graph.microsoft.com/v1.0/me/drive/root/delta?$select=id,name,eTag,parentReference,file,folder,deleted";

export function buildDeltaRunner(): (connection: {
  userId: string;
  provider: string;
}) => Promise<DeltaSyncResult> {
  return async (connection) => {
    const [clientId, clientSecret] = await Promise.all([
      readSsmParameter(env("ONEDRIVE_CLIENT_ID_SSM_PATH", "/petroglyph/onedrive/client-id")),
      readSsmParameter(
        env("ONEDRIVE_CLIENT_SECRET_SSM_PATH", "/petroglyph/onedrive/client-secret"),
      ),
    ]);
    const tokenClient = new OAuthTokenClient({ clientId, clientSecret });
    const resolver = new OAuthTokenResolver({
      store: new DynamoDBTokenStore({
        client: docClient,
        tableName: requiredEnv("REFRESH_TOKENS_TABLE"),
      }),
      now: () => Math.floor(Date.now() / 1000),
      requestTokens: (refreshToken) => tokenClient.requestTokens(refreshToken),
    });

    const profiles = (
      await listProfiles(docClient, requiredEnv("SYNC_PROFILES_TABLE"), connection.userId)
    )
      .filter((profile) => profile.enabled && profile.active)
      .map((profile) => ({ profileId: profile.profileId, rootPath: profile.sourceFolderPath }));

    return runDeltaSync({
      client: new MicrosoftGraphClient({
        baseUrl: env("GRAPH_BASE_URL", "https://graph.microsoft.com/v1.0"),
        resolveAccessToken: (options) =>
          resolver.resolveAccessToken(connection.userId, connection.provider, options),
      }),
      store: new S3StagedObjectStore({
        bucket: requiredEnv("STAGED_PDFS_BUCKET"),
        region: env("AWS_REGION", "eu-west-2"),
      }),
      eventLog: new DynamoDBEventLogWriter({
        client: docClient,
        tableName: requiredEnv("EVENT_LOG_TABLE"),
      }),
      deltaStateStore: createDeltaStateStoreDdb({
        client: docClient,
        tableName: requiredEnv("DELTA_TOKENS_TABLE"),
      }),
      connection,
      profiles,
      initialUrl: env("GRAPH_DRIVE_ROOT_DELTA_URL", DEFAULT_DRIVE_ROOT_DELTA_URL),
    });
  };
}

export const handler = (event: SQSEvent): Promise<SQSBatchResponse> =>
  createAdapterHandler({ runDelta: buildDeltaRunner() })(event);

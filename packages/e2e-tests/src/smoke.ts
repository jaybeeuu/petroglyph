import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { pathToFileURL } from "node:url";
import { createSmokeAws, type SmokeAws } from "./aws.js";
import { readSmokeConfig, type SmokeConfig } from "./config.js";
import {
  SMOKE_ITEM_ID,
  SMOKE_ITEM_NAME,
  SMOKE_RELATIVE_PATH,
  SMOKE_USERNAME,
  SMOKE_USER_ID,
  createSmokeProfile,
  createSmokeTokenVault,
  smokeResetKeys,
  smokeTrigger,
} from "./fixtures.js";
import { isPdf, parseFeed, type FeedEntry } from "./feed.js";
import { mintSmokeJwt } from "./jwt.js";
import { waitForRecord, type SmokeClock } from "./poll.js";

export interface RunSmokeDeps {
  config: SmokeConfig;
  aws: SmokeAws;
  fetchFn: typeof fetch;
  clock: SmokeClock;
  /** Mints the delivery identity token; injected so the journey is testable. */
  mintJwt: (userId: string, username: string) => Promise<string>;
  log: (message: string) => void;
}

/**
 * Clears the state a previous run may have left, so the journey is repeatable.
 * The delta change token in particular must go: without it the adapter would
 * follow a settled deltaLink and never re-enumerate the fixture. The staged
 * record is cleared so the poll observes the new journey, not a stale row.
 */
async function resetState(deps: RunSmokeDeps): Promise<void> {
  const keys = smokeResetKeys();
  const { config } = deps;
  await deps.aws.deleteItem(config.syncProfilesTable, keys.syncProfile);
  await deps.aws.deleteItem(config.tokenVaultsTable, keys.tokenVault);
  await deps.aws.deleteItem(config.deltaStatesTable, keys.deltaState);
  await deps.aws.deleteItem(config.stagedRecordsTable, keys.stagedRecord);
}

async function seedState(deps: RunSmokeDeps, nowEpochSeconds: number): Promise<void> {
  const { config } = deps;
  const now = new Date(nowEpochSeconds * 1000).toISOString();
  await deps.aws.putItem(config.syncProfilesTable, {
    ...createSmokeProfile(now),
  });
  await deps.aws.putItem(config.tokenVaultsTable, {
    userId: SMOKE_USER_ID,
    provider: smokeTrigger().provider,
    ...createSmokeTokenVault(nowEpochSeconds),
  });
}

async function triggerAdapter(deps: RunSmokeDeps): Promise<void> {
  const message = JSON.stringify(smokeTrigger());
  await deps.aws.sendMessage(
    deps.config.deltaTriggerQueueUrl,
    message,
    `smoke-${deps.clock.now().toString()}`,
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function fetchFeedEntry(deps: RunSmokeDeps, jwt: string): Promise<FeedEntry> {
  const url = new URL("/files", deps.config.apiBaseUrl);
  const response = await deps.fetchFn(url, {
    headers: { authorization: `Bearer ${jwt}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    throw new Error(`GET ${url.pathname} returned ${response.status}: ${await response.text()}`);
  }
  const entries = parseFeed(await response.json());
  const entry = entries.find((candidate) => candidate.itemId === SMOKE_ITEM_ID);
  if (entry === undefined) {
    throw new Error(`/files did not include ${SMOKE_ITEM_ID}`);
  }
  return entry;
}

async function downloadEntry(deps: RunSmokeDeps, entry: FeedEntry): Promise<Uint8Array> {
  const response = await deps.fetchFn(entry.s3PresignedUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`presigned GET returned ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!isPdf(bytes)) {
    throw new Error("downloaded object is not a PDF");
  }
  return bytes;
}

/**
 * The deterministic QA journey: reset -> seed a profile + valid token ->
 * wake the deployed adapter -> wait for the forwarder/dispatch pipeline to
 * index the staged object -> read it from `/files` with a real QA JWT ->
 * download the presigned object. Microsoft Graph is the only mocked service;
 * every other hop is the deployed QA stack.
 */
export async function runSmoke(deps: RunSmokeDeps): Promise<void> {
  const { config } = deps;
  const timeoutMs = config.timeoutSeconds * 1000;

  deps.log("resetting smoke state");
  await resetState(deps);

  deps.log("seeding profile and connection token");
  await seedState(deps, Math.floor(deps.clock.now() / 1000));

  deps.log("triggering the deployed adapter");
  await triggerAdapter(deps);

  const record = await waitForRecord({
    read: () =>
      deps.aws.getItem(config.stagedRecordsTable, {
        profileId: smokeResetKeys().stagedRecord["profileId"],
        itemId: SMOKE_ITEM_ID,
      }),
    label: "the staged record to appear",
    timeoutMs,
    intervalMs: config.pollIntervalMs,
    clock: deps.clock,
    log: deps.log,
  });

  const name = asString(record["name"]);
  const mimeType = asString(record["mimeType"]);
  const relativePath = asString(record["relativePath"]);
  if (
    name !== SMOKE_ITEM_NAME ||
    mimeType !== "application/pdf" ||
    relativePath !== SMOKE_RELATIVE_PATH
  ) {
    throw new Error(
      `staged record does not match the fixture: name=${name ?? "<missing>"} mimeType=${mimeType ?? "<missing>"} relativePath=${relativePath ?? "<missing>"}`,
    );
  }

  deps.log("reading the staged file through /files");
  const jwt = await deps.mintJwt(SMOKE_USER_ID, SMOKE_USERNAME);
  const entry = await fetchFeedEntry(deps, jwt);
  const bytes = await downloadEntry(deps, entry);

  deps.log(`smoke passed: ${entry.name} (${bytes.byteLength} bytes) via presigned GET`);
}

export async function main(): Promise<void> {
  const config = readSmokeConfig(process.env);
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
  const aws = createSmokeAws({
    documentClient,
    sqsClient: new SQSClient({ region: config.region }),
    ssmClient: new SSMClient({ region: config.region }),
  });

  const privateKeyPem =
    config.jwtPrivateKey ?? (await aws.getParameter(config.jwtPrivateKeySsmPath));

  await runSmoke({
    config,
    aws,
    fetchFn: fetch,
    clock: {
      now: () => Date.now(),
      sleep: (milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }),
    },
    mintJwt: (userId, username) => mintSmokeJwt({ privateKeyPem, userId, username }),
    log: (message) => {
      console.log(message);
    },
  });
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main().catch((error: unknown) => {
    console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

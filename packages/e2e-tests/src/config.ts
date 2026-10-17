import { z } from "zod";

/**
 * The smoke context the deploy workflow hands the runner. Everything is
 * required except the two timing knobs, so a missing URL or table name fails
 * before any AWS call instead of surfacing as a confusing runtime error.
 */
export const smokeConfigSchema = z.object({
  apiBaseUrl: z.url(),
  deltaTriggerQueueUrl: z.url(),
  stagedRecordsTable: z.string().min(1),
  syncProfilesTable: z.string().min(1),
  tokenVaultsTable: z.string().min(1),
  deltaStatesTable: z.string().min(1),
  jwtPrivateKeySsmPath: z.string().min(1),
  /** Inline PEM override; when present the runner never reads SSM. */
  jwtPrivateKey: z.string().min(1).optional(),
  region: z.string().min(1),
  timeoutSeconds: z.coerce.number().int().positive().default(120),
  pollIntervalMs: z.coerce.number().int().positive().default(2000),
});

export type SmokeConfig = z.infer<typeof smokeConfigSchema>;

export interface SmokeEnvironment {
  readonly [name: string]: string | undefined;
}

/**
 * Maps the workflow's environment variables onto the config. Validation is
 * left to the schema so a malformed value names its field in the error.
 */
export function readSmokeConfig(environment: SmokeEnvironment): SmokeConfig {
  return smokeConfigSchema.parse({
    apiBaseUrl: environment["SMOKE_API_BASE_URL"],
    deltaTriggerQueueUrl: environment["SMOKE_DELTA_TRIGGER_QUEUE_URL"],
    stagedRecordsTable: environment["SMOKE_STAGED_RECORDS_TABLE"],
    syncProfilesTable: environment["SMOKE_SYNC_PROFILES_TABLE"],
    tokenVaultsTable: environment["SMOKE_TOKEN_VAULTS_TABLE"],
    deltaStatesTable: environment["SMOKE_DELTA_STATES_TABLE"],
    jwtPrivateKeySsmPath: environment["SMOKE_JWT_PRIVATE_KEY_SSM_PATH"],
    jwtPrivateKey: environment["SMOKE_JWT_PRIVATE_KEY"],
    region: environment["AWS_REGION"],
    timeoutSeconds: environment["SMOKE_TIMEOUT_SECONDS"],
    pollIntervalMs: environment["SMOKE_POLL_INTERVAL_MS"],
  });
}

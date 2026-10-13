import { describe, expect, it } from "vitest";
import { readSmokeConfig, type SmokeEnvironment } from "./config.js";

function createEnvironment(overrides: Partial<SmokeEnvironment> = {}): SmokeEnvironment {
  return {
    SMOKE_API_BASE_URL: "https://api.example.test",
    SMOKE_DELTA_TRIGGER_QUEUE_URL: "https://sqs.eu-west-2.amazonaws.com/123/delta-trigger.fifo",
    SMOKE_STAGED_RECORDS_TABLE: "staged-records",
    SMOKE_SYNC_PROFILES_TABLE: "sync-profiles",
    SMOKE_TOKEN_VAULTS_TABLE: "token-vaults",
    SMOKE_DELTA_STATES_TABLE: "delta-states",
    SMOKE_JWT_PRIVATE_KEY_SSM_PATH: "/petroglyph/qa/jwt/private-key",
    AWS_REGION: "eu-west-2",
    ...overrides,
  };
}

describe("readSmokeConfig", () => {
  it("maps the workflow environment onto the smoke context", () => {
    expect(readSmokeConfig(createEnvironment())).toMatchObject({
      apiBaseUrl: "https://api.example.test",
      deltaTriggerQueueUrl: "https://sqs.eu-west-2.amazonaws.com/123/delta-trigger.fifo",
      stagedRecordsTable: "staged-records",
      region: "eu-west-2",
    });
  });

  it("defaults the timing knobs so a context without them still runs", () => {
    const config = readSmokeConfig(createEnvironment());

    expect(config.timeoutSeconds).toBe(120);
    expect(config.pollIntervalMs).toBe(2000);
  });

  it("keeps an inline private key override so local runs skip SSM", () => {
    const config = readSmokeConfig(
      createEnvironment({ SMOKE_JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----" }),
    );

    expect(config.jwtPrivateKey).toBe("-----BEGIN PRIVATE KEY-----");
  });

  it("rejects a context missing a required table", () => {
    expect(() =>
      readSmokeConfig(createEnvironment({ SMOKE_STAGED_RECORDS_TABLE: undefined })),
    ).toThrow();
  });
});

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createTokenResolver, type TokenRecord, type TokenRequestOutcome } from "@petroglyph/core";
import { createTokenStoreDdb } from "./token-store-ddb.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const canRun = dockerAvailable();
const TABLE_NAME = "refresh-tokens-int";

const stale: TokenRecord = {
  accessToken: "stale-token",
  refreshToken: "stale-refresh",
  expirySeconds: 100,
  updatedAt: "2026-09-01T00:00:00.000Z",
  reconnectRequired: false,
};

const persistenceDeadline = new Date(Date.now() + 1000 * 3600).valueOf() / 1000;

describe.skipIf(!canRun)("token store CAS + resolver concurrency against LocalStack DDB", () => {
  let container: StartedTestContainer;
  let store: ReturnType<typeof createTokenStoreDdb>;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: "eu-west-2",
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .start();

    const endpoint = `http://${container.getHost()}:${container.getMappedPort(4566)}`;
    const dynamoClient = new DynamoDBClient({
      region: "eu-west-2",
      endpoint,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await dynamoClient.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "provider", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "userId", AttributeType: "S" },
          { AttributeName: "provider", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    store = createTokenStoreDdb({
      client: DynamoDBDocumentClient.from(dynamoClient),
      tableName: TABLE_NAME,
    });
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("CAS write really gates a stale writer while the winner's rotation survives", async () => {
    await store.write("github|cas", "onedrive", stale, undefined);

    const winner: TokenRecord = {
      accessToken: "winner-token",
      refreshToken: "winner-refresh",
      expirySeconds: persistenceDeadline,
      updatedAt: "2026-09-01T00:00:01.000Z",
      reconnectRequired: false,
    };
    const loser: TokenRecord = {
      accessToken: "loser-token",
      refreshToken: "loser-refresh",
      expirySeconds: persistenceDeadline,
      updatedAt: "2026-09-01T00:00:02.000Z",
      reconnectRequired: false,
    };

    expect(await store.write("github|cas", "onedrive", winner, stale)).toBe(true);
    // loser still holds the stale snapshot → its CAS must fail
    expect(await store.write("github|cas", "onedrive", loser, stale)).toBe(false);

    const stored = await store.read("github|cas", "onedrive");
    expect(stored?.accessToken).toBe("winner-token");
    expect(stored?.refreshToken).toBe("winner-refresh");
    expect(stored?.updatedAt).toBe(winner.updatedAt);
  });

  it("concurrent resolves on one connection collapse to one MS call, both get the winner token", async () => {
    await store.write("github|race", "onedrive", stale, undefined);
    let release!: (outcome: TokenRequestOutcome) => void;
    const parked = new Promise<TokenRequestOutcome>((resolve) => {
      release = resolve;
    });
    const requestTokens = vi.fn().mockReturnValue(parked);
    const resolver = createTokenResolver({ store, now: () => 200, requestTokens });

    const first = resolver.resolveAccessToken("github|race", "onedrive");
    const second = resolver.resolveAccessToken("github|race", "onedrive");

    release({
      kind: "success",
      accessToken: "rotated-token",
      refreshToken: "rotated-refresh",
      expiresIn: 3600,
    });
    const outcomes = await Promise.all([first, second]);

    expect(requestTokens).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toEqual({ kind: "success", accessToken: "rotated-token" });
    expect(outcomes[1]).toEqual({ kind: "success", accessToken: "rotated-token" });
    const stored = await store.read("github|race", "onedrive");
    expect(stored?.refreshToken).toBe("rotated-refresh");
  });

  it("CAS conflict under a racing writer: loser refetches and returns the winner's token", async () => {
    await store.write("github|cfs", "onedrive", stale, undefined);
    let release!: (outcome: TokenRequestOutcome) => void;
    const parked = new Promise<TokenRequestOutcome>((resolve) => {
      release = resolve;
    });
    const requestTokens = vi.fn().mockReturnValue(parked);
    const resolver = createTokenResolver({ store, now: () => 200, requestTokens });

    const resolving = resolver.resolveAccessToken("github|cfs", "onedrive");

    // Winner rotates before the parked loser's CAS attempt.
    await store.write(
      "github|cfs",
      "onedrive",
      {
        accessToken: "winner-token",
        refreshToken: "winner-refresh",
        expirySeconds: persistenceDeadline,
        updatedAt: "2026-09-01T00:00:03.000Z",
        reconnectRequired: false,
      },
      undefined,
    );

    release({
      kind: "success",
      accessToken: "loser-token",
      refreshToken: "loser-refresh",
      expiresIn: 3600,
    });
    const outcome = await resolving;

    expect(outcome).toEqual({ kind: "success", accessToken: "winner-token" });
    const stored = await store.read("github|cfs", "onedrive");
    expect(stored?.accessToken).toBe("winner-token");
    expect(stored?.refreshToken).toBe("winner-refresh");
  });
});

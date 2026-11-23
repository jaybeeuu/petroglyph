import {
  CreateTableCommand,
  DynamoDBClient,
  type AttributeDefinition,
  type KeySchemaElement,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { resetKeyCache } from "./jwt.js";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const SYNC_PROFILES_TABLE = "petroglyph-sync-profiles-status-int";
const GRAPH_SUBSCRIPTIONS_TABLE = "petroglyph-graph-subscriptions-status-int";

/**
 * `/status` derives `reconnect_required` from the subscription registry rows of
 * the user's live profiles, so the derivation is proven against the real table:
 * the key it reads by, the provider sort key, and the deleted-profile filter.
 */
describe("GET /status against LocalStack DynamoDB", () => {
  let container: StartedTestContainer;
  let dynamo: DynamoDBDocumentClient;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: REGION,
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .withStartupTimeout(120_000)
      .start();

    const endpoint = `http://localhost:${container.getMappedPort(4566)}`;
    const client = new DynamoDBClient({ region: REGION, endpoint, credentials: CREDENTIALS });

    await createTable(client, SYNC_PROFILES_TABLE, "userId", "profileId");
    await createTable(client, GRAPH_SUBSCRIPTIONS_TABLE, "profileId", "provider");
    dynamo = DynamoDBDocumentClient.from(client);

    // The handler composes its own document client from the environment, so
    // these redirect it at LocalStack before the first request is served.
    vi.stubEnv("AWS_ENDPOINT_URL_DYNAMODB", endpoint);
    vi.stubEnv("AWS_ACCESS_KEY_ID", CREDENTIALS.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", CREDENTIALS.secretAccessKey);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("SYNC_PROFILES_TABLE", SYNC_PROFILES_TABLE);
    vi.stubEnv("GRAPH_SUBSCRIPTIONS_TABLE", GRAPH_SUBSCRIPTIONS_TABLE);

    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    vi.stubEnv("JWT_PUBLIC_KEY", await exportSPKI(keyPair.publicKey));
    resetKeyCache();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    vi.unstubAllEnvs();
    resetKeyCache();
  }, 30_000);

  it("reports reconnect_required when every live profile's subscription has failed", async () => {
    const userId = "user-every-failed";
    await putProfile(userId, { profileId: "profile-a" });
    await putProfile(userId, { profileId: "profile-b" });
    await putSubscription("profile-a", "failed");
    await putSubscription("profile-b", "failed");

    const status = await getStatus(userId);

    expect(status).toMatchObject({
      oneDrive: { connected: false },
      oneDriveStatus: "reconnect_required",
    });
  }, 60_000);

  it("reports connected when one live profile's subscription is active", async () => {
    const userId = "user-one-active";
    await putProfile(userId, { profileId: "profile-failed" });
    await putProfile(userId, { profileId: "profile-active" });
    await putSubscription("profile-failed", "failed");
    await putSubscription("profile-active", "active");

    const status = await getStatus(userId);

    expect(status).toMatchObject({
      oneDrive: { connected: true },
      oneDriveStatus: "connected",
    });
  }, 60_000);

  it("ignores a soft-deleted profile's failed subscription", async () => {
    const userId = "user-deleted-profile";
    await putProfile(userId, { profileId: "profile-gone", deletedAt: "2024-06-01T00:00:00.000Z" });
    await putSubscription("profile-gone", "failed");

    const status = await getStatus(userId);

    expect(status).toMatchObject({ oneDriveStatus: "never_connected" });
  }, 60_000);

  async function getStatus(
    userId: string,
  ): Promise<{ oneDrive: { connected: boolean }; oneDriveStatus: string }> {
    const token = await makeToken(userId);
    const response = await createApp().request("/status", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    return (await response.json()) as {
      oneDrive: { connected: boolean };
      oneDriveStatus: string;
    };
  }

  /** Writes a stored profile row, with the schema fields a reader needs. */
  async function putProfile(
    userId: string,
    overrides: { profileId: string; deletedAt?: string },
  ): Promise<void> {
    await dynamo.send(
      new PutCommand({
        TableName: SYNC_PROFILES_TABLE,
        Item: {
          userId,
          name: "A profile",
          sourceFolderPath: "Notes",
          destinationVaultPath: "vault",
          pollingIntervalMinutes: 5,
          enabled: true,
          active: true,
          initialSyncEnabled: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          ...overrides,
        },
      }),
    );
  }

  async function putSubscription(profileId: string, subscriptionState: string): Promise<void> {
    await dynamo.send(
      new PutCommand({
        TableName: GRAPH_SUBSCRIPTIONS_TABLE,
        Item: {
          profileId,
          provider: "onedrive",
          root: "/drives/drive-1/root",
          subscriptionId: `sub-${profileId}`,
          expiry: 1_800_000_000,
          subscriptionState,
        },
      }),
    );
  }

  async function makeToken(userId: string): Promise<string> {
    return new SignJWT({ username: "octocat" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(userId)
      .setIssuer("petroglyph-api")
      .setAudience("petroglyph-plugin")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }
});

function createTable(
  client: DynamoDBClient,
  tableName: string,
  hashKey: string,
  rangeKey: string,
): Promise<void> {
  const keySchema: KeySchemaElement[] = [
    { AttributeName: hashKey, KeyType: "HASH" },
    { AttributeName: rangeKey, KeyType: "RANGE" },
  ];
  const attributeDefinitions: AttributeDefinition[] = [
    { AttributeName: hashKey, AttributeType: "S" },
    { AttributeName: rangeKey, AttributeType: "S" },
  ];

  return client
    .send(
      new CreateTableCommand({
        TableName: tableName,
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions,
        BillingMode: "PAY_PER_REQUEST",
      }),
    )
    .then(() => undefined);
}

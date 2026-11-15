import {
  CreateTableCommand,
  DynamoDBClient,
  type AttributeDefinition,
  type KeySchemaElement,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { resetKeyCache } from "./jwt.js";

const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const SYNC_PROFILES_TABLE = "petroglyph-sync-profiles-crud-int";
const FILE_RECORDS_TABLE = "petroglyph-file-records-crud-int";
const USERS_TABLE = "petroglyph-users-crud-int";
const USER_ID = "user-42";

/** A profile row as DynamoDB stores it, including attributes outside the domain schema. */
interface StoredProfile {
  [attribute: string]: unknown;
}

describe("profiles CRUD against LocalStack DynamoDB", () => {
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
    await createTable(client, FILE_RECORDS_TABLE, "profileId", "fileId");
    await createTable(client, USERS_TABLE, "userId");
    dynamo = DynamoDBDocumentClient.from(client);

    // The handlers compose their own document client from the environment, so
    // these redirect it at LocalStack before the first request is served.
    vi.stubEnv("AWS_ENDPOINT_URL_DYNAMODB", endpoint);
    vi.stubEnv("AWS_ACCESS_KEY_ID", CREDENTIALS.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", CREDENTIALS.secretAccessKey);
    vi.stubEnv("AWS_REGION", REGION);
    vi.stubEnv("SYNC_PROFILES_TABLE", SYNC_PROFILES_TABLE);
    vi.stubEnv("FILE_RECORDS_TABLE", FILE_RECORDS_TABLE);
    vi.stubEnv("USERS_TABLE", USERS_TABLE);

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

  it("sets the attribute the request names and leaves the rest of the row alone", async () => {
    const userId = "user-rename";
    await putStoredProfile(
      { profileId: "profile-rename", name: "Old Name", oneDriveConnected: true },
      userId,
    );

    const response = await request("PUT", "/profiles/profile-rename", { name: "New Name" }, userId);

    expect(response.status).toBe(200);
    const stored = await readStoredProfile("profile-rename", userId);
    expect(stored["name"]).toBe("New Name");
    expect(stored["oneDriveConnected"]).toBe(true);
  });

  it("keeps the OneDrive connection marker when a connected profile is activated", async () => {
    const userId = "user-activate";
    await putStoredProfile(
      { profileId: "profile-activate", active: false, oneDriveConnected: true },
      userId,
    );

    const response = await request("PUT", "/profiles/profile-activate", { active: true }, userId);

    expect(response.status).toBe(200);
    const stored = await readStoredProfile("profile-activate", userId);
    expect(stored["active"]).toBe(true);
    expect(stored["oneDriveConnected"]).toBe(true);
  });

  it("reports connected after a connect followed by a profile update", async () => {
    const userId = "user-status";
    // The connect path stamps `oneDriveConnected` on the default profile.
    await putStoredProfile({ profileId: "default", oneDriveConnected: true }, userId);
    await dynamo.send(
      new PutCommand({
        TableName: USERS_TABLE,
        Item: { userId, oneDriveStatus: "connected" },
      }),
    );

    const updateResponse = await request(
      "PUT",
      "/profiles/default",
      { pollingIntervalMinutes: 10 },
      userId,
    );
    const statusResponse = await request("GET", "/status", undefined, userId);

    expect(updateResponse.status).toBe(200);
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      oneDrive: { connected: true },
      oneDriveStatus: "connected",
    });
  });

  it("creates a profile with every attribute a new profile needs", async () => {
    const newUserId = "user-without-profiles";

    const response = await request(
      "POST",
      "/profiles",
      { name: "Created", sourceFolderPath: "/Notes", destinationVaultPath: "vault" },
      newUserId,
    );

    expect(response.status).toBe(201);
    const created = (await response.json()) as { profileId: string };
    const stored = await readStoredProfile(created.profileId, newUserId);
    expect(stored).toMatchObject({
      userId: newUserId,
      name: "Created",
      sourceFolderPath: "Notes",
      destinationVaultPath: "vault",
      pollingIntervalMinutes: 5,
      enabled: true,
      active: true,
      initialSyncEnabled: true,
    });
    expect(stored["createdAt"]).toEqual(expect.any(String));
  });

  it("promotes the newest remaining profile without clearing its connection marker", async () => {
    const userId = "user-delete";
    await putStoredProfile(
      { profileId: "profile-active", active: true, createdAt: "2024-01-01T00:00:00.000Z" },
      userId,
    );
    await putStoredProfile(
      {
        profileId: "profile-newest",
        active: false,
        createdAt: "2024-06-01T00:00:00.000Z",
        oneDriveConnected: true,
      },
      userId,
    );

    const response = await request("DELETE", "/profiles/profile-active", undefined, userId);

    expect(response.status).toBe(204);
    const promoted = await readStoredProfile("profile-newest", userId);
    expect(promoted["active"]).toBe(true);
    expect(promoted["oneDriveConnected"]).toBe(true);
  });

  async function request(
    method: string,
    path: string,
    body?: unknown,
    userId = USER_ID,
  ): Promise<Response> {
    const token = await makeToken(userId);
    return createApp().request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  /** Writes a stored profile row, with the schema fields a reader needs. */
  async function putStoredProfile(
    overrides: StoredProfile & { profileId: string },
    userId = USER_ID,
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

  async function readStoredProfile(profileId: string, userId = USER_ID): Promise<StoredProfile> {
    const result = await dynamo.send(
      new GetCommand({
        TableName: SYNC_PROFILES_TABLE,
        Key: { userId, profileId },
      }),
    );
    const item = result.Item;
    if (item === undefined) {
      throw new Error(`No stored profile ${profileId}`);
    }
    return item;
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
  rangeKey?: string,
): Promise<void> {
  const keySchema: KeySchemaElement[] = [{ AttributeName: hashKey, KeyType: "HASH" }];
  const attributeDefinitions: AttributeDefinition[] = [
    { AttributeName: hashKey, AttributeType: "S" },
  ];
  if (rangeKey !== undefined) {
    keySchema.push({ AttributeName: rangeKey, KeyType: "RANGE" });
    attributeDefinitions.push({ AttributeName: rangeKey, AttributeType: "S" });
  }

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

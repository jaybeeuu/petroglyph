import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  deleteProfile,
  getProfile,
  listProfiles,
  putProfile,
} from "./sync-profile-db.js";
import type { SyncProfile } from "./sync-profile.js";

const TABLE_NAME = "test-sync-profiles";

const makeClient = (sendImpl: (cmd: unknown) => unknown): DynamoDBDocumentClient =>
  ({ send: vi.fn().mockImplementation(sendImpl) }) as unknown as DynamoDBDocumentClient;

const testProfile: SyncProfile = {
  profileId: "prof-1",
  userId: "user-1",
  name: "My Profile",
  sourceFolderPath: "/source",
  destinationVaultPath: "/vault",
  pollingIntervalMinutes: 5,
  enabled: true,
  active: false,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("getProfile", () => {
  it("returns the profile when found", async () => {
    const client = makeClient(() => ({ Item: testProfile }));
    const result = await getProfile(client, TABLE_NAME, "user-1", "prof-1");
    expect(result).toEqual(testProfile);
  });

  it("returns null when item not found", async () => {
    const client = makeClient(() => ({}));
    const result = await getProfile(client, TABLE_NAME, "user-1", "prof-1");
    expect(result).toBeNull();
  });

  it("sends GetCommand with correct keys", async () => {
    const client = makeClient(() => ({ Item: testProfile }));
    await getProfile(client, TABLE_NAME, "user-1", "prof-1");
    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    expect(send).toHaveBeenCalledOnce();
    const call = send.mock.calls[0] as [{ input: unknown }];
    expect(call[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { userId: "user-1", profileId: "prof-1" },
    });
  });
});

describe("listProfiles", () => {
  it("returns all profiles for a user", async () => {
    const client = makeClient(() => ({ Items: [testProfile] }));
    const result = await listProfiles(client, TABLE_NAME, "user-1");
    expect(result).toEqual([testProfile]);
  });

  it("returns empty array when no profiles exist", async () => {
    const client = makeClient(() => ({ Items: [] }));
    const result = await listProfiles(client, TABLE_NAME, "user-1");
    expect(result).toEqual([]);
  });

  it("sends QueryCommand with correct expression", async () => {
    const client = makeClient(() => ({ Items: [] }));
    await listProfiles(client, TABLE_NAME, "user-1");
    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    const call = send.mock.calls[0] as [{ input: unknown }];
    expect(call[0].input).toEqual({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": "user-1" },
    });
  });
});

describe("putProfile", () => {
  it("sends PutCommand with the profile", async () => {
    const client = makeClient(() => ({}));
    await putProfile(client, TABLE_NAME, testProfile);
    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    const call = send.mock.calls[0] as [{ input: unknown }];
    expect(call[0].input).toEqual({
      TableName: TABLE_NAME,
      Item: testProfile,
    });
  });
});

describe("deleteProfile", () => {
  it("sends DeleteCommand with correct keys", async () => {
    const client = makeClient(() => ({}));
    await deleteProfile(client, TABLE_NAME, "user-1", "prof-1");
    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    const call = send.mock.calls[0] as [{ input: unknown }];
    expect(call[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { userId: "user-1", profileId: "prof-1" },
    });
  });
});

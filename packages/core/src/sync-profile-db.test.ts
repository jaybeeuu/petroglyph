import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  deleteProfile,
  getProfile,
  listProfiles,
  putProfile,
  updateProfile,
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
  initialSyncEnabled: true,
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
      ExclusiveStartKey: undefined,
    });
  });

  it("handles multi-page pagination by fetching all pages", async () => {
    const profile2: SyncProfile = { ...testProfile, profileId: "prof-2" };
    const lastKey = { userId: "user-1", profileId: "prof-1" };
    let callCount = 0;
    const client = makeClient(() => {
      callCount += 1;
      if (callCount === 1) {
        return { Items: [testProfile], LastEvaluatedKey: lastKey };
      }
      return { Items: [profile2] };
    });

    const result = await listProfiles(client, TABLE_NAME, "user-1");

    expect(result).toEqual([testProfile, profile2]);
    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    expect(send).toHaveBeenCalledTimes(2);
    const secondCall = send.mock.calls[1] as [{ input: { ExclusiveStartKey: unknown } }];
    expect(secondCall[0].input.ExclusiveStartKey).toEqual(lastKey);
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

describe("updateProfile", () => {
  it("sets the change on the profile's key without replacing the item", async () => {
    const client = makeClient(() => ({}));

    await updateProfile(client, TABLE_NAME, "user-1", "prof-1", {
      name: "Renamed",
      updatedAt: "2024-02-02T00:00:00.000Z",
    });

    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    const call = send.mock.calls[0] as [{ input: unknown }];
    expect(call[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { userId: "user-1", profileId: "prof-1" },
      UpdateExpression: "SET #attribute0 = :value0, #attribute1 = :value1",
      ConditionExpression: "attribute_exists(userId)",
      ExpressionAttributeNames: { "#attribute0": "name", "#attribute1": "updatedAt" },
      ExpressionAttributeValues: { ":value0": "Renamed", ":value1": "2024-02-02T00:00:00.000Z" },
    });
  });

  it("clears an attribute mapped to null with a REMOVE clause", async () => {
    const client = makeClient(() => ({}));

    await updateProfile(client, TABLE_NAME, "user-1", "prof-1", { enabled: null });

    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    const call = send.mock.calls[0] as [{ input: unknown }];
    expect(call[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { userId: "user-1", profileId: "prof-1" },
      UpdateExpression: "REMOVE #attribute0",
      ConditionExpression: "attribute_exists(userId)",
      ExpressionAttributeNames: { "#attribute0": "enabled" },
    });
  });

  it("guards the update so a missing profile is rejected, not created", async () => {
    const client = makeClient(() => ({}));

    await updateProfile(client, TABLE_NAME, "user-1", "prof-1", { name: "Renamed" });

    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    const call = send.mock.calls[0] as [{ input: { ConditionExpression?: string } }];
    expect(call[0].input.ConditionExpression).toBe("attribute_exists(userId)");
  });

  it("sends no command when no attribute is named", async () => {
    const client = makeClient(() => ({}));

    await updateProfile(client, TABLE_NAME, "user-1", "prof-1", {});

    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    expect(send).not.toHaveBeenCalled();
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

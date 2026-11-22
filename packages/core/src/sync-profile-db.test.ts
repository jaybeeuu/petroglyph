import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  getProfile,
  listProfiles,
  putProfile,
  softDeleteProfile,
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

  it("keeps the purge completion marker a purge wrote", async () => {
    const client = makeClient(() => ({
      Item: {
        ...testProfile,
        deletedAt: "2024-03-03T00:00:00.000Z",
        purgedAt: "2024-03-03T01:00:00.000Z",
      },
    }));

    const result = await getProfile(client, TABLE_NAME, "user-1", "prof-1");

    expect(result).toMatchObject({
      deletedAt: "2024-03-03T00:00:00.000Z",
      purgedAt: "2024-03-03T01:00:00.000Z",
    });
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
      FilterExpression: "attribute_not_exists(deletedAt)",
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
      ConditionExpression: "attribute_exists(userId) AND attribute_not_exists(deletedAt)",
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
      ConditionExpression: "attribute_exists(userId) AND attribute_not_exists(deletedAt)",
      ExpressionAttributeNames: { "#attribute0": "enabled" },
    });
  });

  it("guards the update so a missing profile is rejected, not created", async () => {
    const client = makeClient(() => ({}));

    await updateProfile(client, TABLE_NAME, "user-1", "prof-1", { name: "Renamed" });

    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    const call = send.mock.calls[0] as [{ input: { ConditionExpression?: string } }];
    expect(call[0].input.ConditionExpression).toBe(
      "attribute_exists(userId) AND attribute_not_exists(deletedAt)",
    );
  });

  it("sends no command when no attribute is named", async () => {
    const client = makeClient(() => ({}));

    await updateProfile(client, TABLE_NAME, "user-1", "prof-1", {});

    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    expect(send).not.toHaveBeenCalled();
  });
});

describe("softDeleteProfile", () => {
  const DELETED_AT = "2024-03-03T00:00:00.000Z";

  it("sets deletedAt on a profile that is not deleted yet", async () => {
    const client = makeClient(() => ({}));

    const outcome = await softDeleteProfile(client, TABLE_NAME, "user-1", "prof-1", DELETED_AT);

    expect(outcome).toBe("deleted");
    const { send } = client as unknown as { send: ReturnType<typeof vi.fn> };
    const call = send.mock.calls[0] as [{ input: unknown }];
    expect(call[0].input).toEqual({
      TableName: TABLE_NAME,
      Key: { userId: "user-1", profileId: "prof-1" },
      UpdateExpression: "SET #attribute0 = :value0",
      ConditionExpression: "attribute_exists(userId) AND attribute_not_exists(deletedAt)",
      ExpressionAttributeNames: { "#attribute0": "deletedAt" },
      ExpressionAttributeValues: { ":value0": DELETED_AT },
    });
  });

  it("reports a profile deleted by an earlier call when the condition fails", async () => {
    const client = makeClient((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "UpdateCommand") {
        return Promise.reject(
          Object.assign(new Error("The conditional request failed"), {
            name: "ConditionalCheckFailedException",
          }),
        );
      }
      return { Item: { ...testProfile, deletedAt: DELETED_AT } };
    });

    const outcome = await softDeleteProfile(client, TABLE_NAME, "user-1", "prof-1", DELETED_AT);

    expect(outcome).toBe("already-deleted");
  });

  it("reports a profile that is not there when the condition fails", async () => {
    const client = makeClient((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "UpdateCommand") {
        return Promise.reject(
          Object.assign(new Error("The conditional request failed"), {
            name: "ConditionalCheckFailedException",
          }),
        );
      }
      return {};
    });

    const outcome = await softDeleteProfile(client, TABLE_NAME, "user-1", "prof-1", DELETED_AT);

    expect(outcome).toBe("missing");
  });

  it("rethrows a failure that is not the condition", async () => {
    const client = makeClient(() => Promise.reject(new Error("throughput exceeded")));

    await expect(
      softDeleteProfile(client, TABLE_NAME, "user-1", "prof-1", DELETED_AT),
    ).rejects.toThrow("throughput exceeded");
  });
});

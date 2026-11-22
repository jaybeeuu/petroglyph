import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { syncProfileSchema } from "./sync-profile.js";
import type { SyncProfile } from "./sync-profile.js";

/**
 * Every write that changes a stored profile is conditional on the row existing
 * and on the profile not being deleted, so a delete that races a stream-driven
 * action wins. A deleted profile is read only.
 */
const LIVE_PROFILE_CONDITION = "attribute_exists(userId) AND attribute_not_exists(deletedAt)";

/** Whether DynamoDB rejected a write because the write's condition did not hold. */
export function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export async function getProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
  profileId: string,
): Promise<SyncProfile | null> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { userId, profileId },
    }),
  );

  if (result.Item === undefined) {
    return null;
  }

  return syncProfileSchema.parse(result.Item);
}

export async function listProfiles(
  client: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
): Promise<SyncProfile[]> {
  const items: { [key: string]: unknown }[] = [];
  let lastEvaluatedKey: { [key: string]: unknown } | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "userId = :userId",
        // A deleted profile is still readable by id, so a scoped route can
        // answer 410 rather than 404, but it never appears in a list.
        FilterExpression: "attribute_not_exists(deletedAt)",
        ExpressionAttributeValues: { ":userId": userId },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of result.Items ?? []) {
      items.push(item);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey !== undefined);

  return items.map((item) => syncProfileSchema.parse(item));
}

/**
 * Stores a whole profile. Use it to create one: a put replaces the item, so it
 * writes every attribute and deletes any attribute it does not name.
 */
export async function putProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  profile: SyncProfile,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: profile,
    }),
  );
}

/** A profile attribute value as DynamoDB stores it. */
export type ProfileAttributeValue = string | number | boolean;

/** The attributes no ordinary update writes; each has its own command. */
type ProfileLifecycleField = "deletedAt" | "purgedAt";

/** Every profile attribute an ordinary update may write. */
type ProfileChangeField = Exclude<keyof SyncProfile, ProfileLifecycleField>;

/**
 * The attributes one profile write names. A field absent from the map keeps its
 * stored value, so an update cannot erase an attribute the writer does not know
 * about — `oneDriveConnected`, for one, is stamped by the connect path and is
 * not part of the domain schema a reader parses.
 *
 * A field mapped to `null` is removed. DynamoDB has no null value, so clearing
 * an optional attribute needs a `REMOVE` clause; a `SET` would store the string
 * `undefined` instead.
 *
 * The lifecycle markers are absent on purpose: {@link softDeleteProfile} is the
 * only writer of `deletedAt`, and the purge is the only writer of `purgedAt`.
 */
export type ProfileChanges = {
  readonly [Field in ProfileChangeField]?: ProfileAttributeValue | null;
};

/**
 * Writes the named attributes of an existing profile and nothing else. The row
 * must exist and must not be deleted: the `attribute_exists` condition rejects a
 * missing one, because an unguarded update would create the item holding only
 * the named attributes and every later read of that row would fail, and
 * `attribute_not_exists(deletedAt)` rejects a soft-deleted one, so a delete
 * wins over a concurrent write. A create keeps using {@link putProfile}.
 */
export async function updateProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
  profileId: string,
  changes: ProfileChanges,
): Promise<void> {
  const assignments: string[] = [];
  const removals: string[] = [];
  const names: { [placeholder: string]: string } = {};
  const values: { [placeholder: string]: ProfileAttributeValue } = {};
  let placeholder = 0;

  for (const [field, value] of Object.entries(changes)) {
    const namePlaceholder = `#attribute${placeholder}`;
    names[namePlaceholder] = field;

    if (value === null) {
      removals.push(namePlaceholder);
    } else {
      const valuePlaceholder = `:value${placeholder}`;
      values[valuePlaceholder] = value;
      assignments.push(`${namePlaceholder} = ${valuePlaceholder}`);
    }

    placeholder += 1;
  }

  if (assignments.length === 0 && removals.length === 0) {
    return;
  }

  const updateExpression = [
    ...(assignments.length > 0 ? [`SET ${assignments.join(", ")}`] : []),
    ...(removals.length > 0 ? [`REMOVE ${removals.join(", ")}`] : []),
  ].join(" ");

  await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { userId, profileId },
      UpdateExpression: updateExpression,
      ConditionExpression: LIVE_PROFILE_CONDITION,
      ExpressionAttributeNames: names,
      ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
    }),
  );
}

/** What a soft delete did, so the caller can answer the request it was given. */
export type ProfileSoftDelete = "deleted" | "already-deleted" | "missing";

/**
 * Soft-deletes a profile by setting `deletedAt`, conditional on the row existing
 * and not being deleted already. The row stays: it is the only durable record
 * that the purge is owed, and `getProfile` still reads it so a profile-scoped
 * route can answer `410` rather than `404`.
 *
 * A repeat delete is a no-op. It reports `already-deleted` and writes nothing, so
 * the timestamp of the first delete survives.
 */
export async function softDeleteProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
  profileId: string,
  deletedAt: string,
): Promise<ProfileSoftDelete> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { userId, profileId },
        UpdateExpression: "SET #attribute0 = :value0",
        ConditionExpression: LIVE_PROFILE_CONDITION,
        ExpressionAttributeNames: { "#attribute0": "deletedAt" },
        ExpressionAttributeValues: { ":value0": deletedAt },
      }),
    );
  } catch (error) {
    if (!isConditionalCheckFailure(error)) {
      throw error;
    }
    // The condition covers both cases, so the row decides which one it was.
    const existing = await getProfile(client, tableName, userId, profileId);
    return existing === null ? "missing" : "already-deleted";
  }

  return "deleted";
}

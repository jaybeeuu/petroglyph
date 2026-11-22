import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { syncProfileSchema } from "./sync-profile.js";
import type { SyncProfile } from "./sync-profile.js";

/**
 * True when a profile row carries a deletion timestamp, whether the caller holds
 * a parsed profile or the raw item. `getProfile` and `listProfiles` apply it so
 * no caller can forget; a reader that must see an attribute outside
 * {@link syncProfileSchema} — `GET /status` reads the connect path's
 * `oneDriveConnected` — reads the raw row and asks this function, so the
 * exclusion still comes from this module.
 */
export function isProfileDeleted(row: { readonly deletedAt?: unknown }): boolean {
  return row.deletedAt !== undefined;
}

export async function getProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
  profileId: string,
): Promise<SyncProfile | null> {
  const row = await readProfileRow(client, tableName, userId, profileId);

  return row === null || isProfileDeleted(row) ? null : row;
}

/**
 * Reads the profile row as stored, including a soft-deleted one. Only the delete
 * path needs it: it must tell "never existed" (404) from "already deleted"
 * (idempotent 200). Every other reader uses {@link getProfile}, which excludes a
 * deleted profile.
 */
export async function readProfileRow(
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
        ExpressionAttributeValues: { ":userId": userId },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of result.Items ?? []) {
      items.push(item);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey !== undefined);

  return items
    .map((item) => syncProfileSchema.parse(item))
    .filter((profile) => !isProfileDeleted(profile));
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

/**
 * The attributes one profile write names. A field absent from the map keeps its
 * stored value, so an update cannot erase an attribute the writer does not know
 * about — `oneDriveConnected`, for one, is stamped by the connect path and is
 * not part of the domain schema a reader parses.
 *
 * A field mapped to `null` is removed. DynamoDB has no null value, so clearing
 * an optional attribute needs a `REMOVE` clause; a `SET` would store the string
 * `undefined` instead.
 */
export type ProfileChanges = {
  readonly [Field in keyof SyncProfile]?: ProfileAttributeValue | null;
};

/**
 * Writes the named attributes of an existing profile and nothing else. The item
 * must exist: the `attribute_exists` condition rejects a missing one, because an
 * unguarded update would create the item holding only the named attributes and
 * every later read of that row would fail. A create keeps using
 * {@link putProfile}.
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
      ConditionExpression: "attribute_exists(userId)",
      ExpressionAttributeNames: names,
      ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
    }),
  );
}

/**
 * Takes the profile out of service: `deletedAt` is set and the row is kept for
 * audit. The row change is also the purge intent — the profiles stream delivers
 * it to the janitor, so this command writes nothing else.
 */
export async function softDeleteProfile(
  client: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
  profileId: string,
  deletedAt: string,
): Promise<void> {
  await updateProfile(client, tableName, userId, profileId, { deletedAt, updatedAt: deletedAt });
}

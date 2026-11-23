import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./db.js";

/** The user record owns identity and every mark the API derives state from. */
export function usersTableName(): string {
  return process.env["USERS_TABLE"] ?? "petroglyph-users-default";
}

/**
 * Records whether the user has at least one profile.
 *
 * `GET /status` reads this mark and no profile row, so editing a profile cannot
 * change the connection state it reports. `POST /profiles` sets it and deleting
 * the last profile clears it.
 *
 * The condition keeps the write to an existing user record: a mark must never
 * create a partial user, and a caller holding a JWT always has one.
 *
 * The write is best-effort. It runs after the profile write has committed, so a
 * mark that cannot be written must not fail a request whose real work is done —
 * the failure is logged instead. The trade: when the users row is absent or the
 * mark is stale, `/status` reports the last mark it holds (`connected_no_profile`
 * for a user with profiles, `connected` for a user without), until the next
 * create or delete repairs it.
 */
export async function setProfilePresence(userId: string, hasProfile: boolean): Promise<void> {
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: usersTableName(),
        Key: { userId },
        UpdateExpression: "SET hasProfile = :hasProfile",
        ConditionExpression: "attribute_exists(userId)",
        ExpressionAttributeValues: { ":hasProfile": hasProfile },
      }),
    );
  } catch (error) {
    console.warn(`[user-record] profile presence not recorded for ${userId}`, error);
  }
}

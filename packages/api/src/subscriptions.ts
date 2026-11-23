import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { docClient } from "./db.js";
import { ONEDRIVE_PROVIDER } from "./token-vault.js";

/**
 * The subscription registry's table name. One definition per table, read per
 * call, so importing this module stays free of I/O and of load-order coupling.
 */
export function graphSubscriptionsTableName(): string {
  return process.env["GRAPH_SUBSCRIPTIONS_TABLE"] ?? "petroglyph-graph-subscriptions-default";
}

/** The states one profile's subscription can hold in the registry. */
export const subscriptionStateSchema = z.enum(["pending", "active", "failed"]);
export type SubscriptionState = z.infer<typeof subscriptionStateSchema>;

/**
 * Only the attribute a status reader needs. The full registry item contract
 * lands in `petroglyph-n20i.18`; parsing the whole item here would reject a row
 * for a field this reader never uses.
 */
const registryStateSchema = z.object({ subscriptionState: subscriptionStateSchema });

/**
 * Reads one profile's subscription state, or `null` when the registry holds no
 * row for it. A row that does not parse answers `null` too: an unreadable row
 * proves nothing about the connection, so it must not raise
 * `reconnect_required` on its own.
 */
export async function readSubscriptionState(profileId: string): Promise<SubscriptionState | null> {
  const result = await docClient().send(
    new GetCommand({
      TableName: graphSubscriptionsTableName(),
      Key: { profileId, provider: ONEDRIVE_PROVIDER },
    }),
  );
  const parsed = registryStateSchema.safeParse(result.Item);
  return parsed.success ? parsed.data.subscriptionState : null;
}

import { z } from "zod";
/**
 * The registry item — one Graph subscription per profile, keyed
 * `(profileId, provider)` — as `petroglyph-graph-subscriptions` stores it.
 *
 * It is the only record of that subscription: the profile row holds no Graph
 * state, so the subscribe action, the renewer and the webhook lookup all read
 * this shape. Every field they need in order to act without a profile read is
 * here, which is why `root`, `folderItemId` and `clientStateSecret` are part of
 * the contract rather than of a caller's memory.
 *
 * The state decides what the row must carry. `stale` and `removed` are not
 * states this table holds: a stale delta token belongs to the walk, and a
 * removed subscription is a deleted row.
 * - `pending` is the intent written before any Graph call, so it has no
 *   `subscriptionId` and no `expiry` until that call answers.
 * - `active` has both, because a renewal reads the expiry and the webhook
 *   answers on the id. `deltaLink` stays optional: a fresh subscription has no
 *   cursor until its first walk returns one.
 * - `failed` keeps whatever the failed attempt left behind, which may be
 *   nothing more than the root the row was written for.
 */
export const subscriptionRegistryItemSchema = z.discriminatedUnion("subscriptionState", [
  z.object({
    profileId: z.string().min(1),
    provider: z.string().min(1),
    /** The profile's source root, its `sourceFolderPath`; a root change rewrites this row. */
    root: z.string().min(1),
    /** The Graph drive-item id of that root, so a recreate addresses the folder without a profile read. */
    folderItemId: z.string().min(1),
    subscriptionState: z.literal("pending"),
    subscriptionId: z.string().min(1).optional(),
    deltaLink: z.string().min(1).optional(),
    /** The shared secret Graph echoes in `clientState`; the webhook authenticates with it. */
    clientStateSecret: z.string().min(1).optional(),
    /** Epoch seconds, which is the type the `expiry` index sorts and ranges over. */
    expiry: z.number().int().positive().optional(),
  }),
  z.object({
    profileId: z.string().min(1),
    provider: z.string().min(1),
    /** The profile's source root, its `sourceFolderPath`; a root change rewrites this row. */
    root: z.string().min(1),
    /** The Graph drive-item id of that root, so a recreate addresses the folder without a profile read. */
    folderItemId: z.string().min(1),
    subscriptionState: z.literal("active"),
    subscriptionId: z.string().min(1),
    deltaLink: z.string().min(1).optional(),
    /** The shared secret Graph echoes in `clientState`; the webhook authenticates with it. */
    clientStateSecret: z.string().min(1),
    /** Epoch seconds, which is the type the `expiry` index sorts and ranges over. */
    expiry: z.number().int().positive(),
  }),
  z.object({
    profileId: z.string().min(1),
    provider: z.string().min(1),
    /** The profile's source root, its `sourceFolderPath`; a root change rewrites this row. */
    root: z.string().min(1),
    /** The Graph drive-item id of that root, so a recreate addresses the folder without a profile read. */
    folderItemId: z.string().min(1),
    subscriptionState: z.literal("failed"),
    subscriptionId: z.string().min(1).optional(),
    deltaLink: z.string().min(1).optional(),
    /** The shared secret Graph echoes in `clientState`; the webhook authenticates with it. */
    clientStateSecret: z.string().min(1).optional(),
    /** Epoch seconds, which is the type the `expiry` index sorts and ranges over. */
    expiry: z.number().int().positive().optional(),
  }),
]);
export type SubscriptionRegistryItem = z.infer<typeof subscriptionRegistryItemSchema>;

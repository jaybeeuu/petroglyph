import { z } from "zod";

/**
 * The kind of change a log row records. A `stage` row means bytes are held for
 * the item at `s3Key`; a `delete` row means the item is gone. Keeping deletes in
 * the log is what lets a client learn that something it holds should be removed
 * — the delivery surface still serves `stage` rows only, so nothing is removed
 * from a vault today.
 */
export const stagedChangeKindSchema = z.enum(["stage", "delete"]);

export type StagedChangeKind = z.infer<typeof stagedChangeKindSchema>;

/**
 * One row of a profile's append-only change log. The row is the client's change
 * order: `seq` is monotonic per profile and a re-staged item gets a NEW `seq`,
 * so a client whose cursor is behind it is served the item again.
 *
 * `profileId` is the sync unit today and `subscriptionId` is the root it came
 * through, so flipping the unit from profile to subscription later is a key
 * change over data that is already present. `content` fields are absent on a
 * delete row because a deleted item has no bytes to point at.
 */
export const stagedChangeSchema = z.object({
  profileId: z.string().min(1),
  subscriptionId: z.string().min(1),
  /** Monotonic per profile; the only field a client cursor is built from. */
  seq: z.number().int().positive(),
  /**
   * The change's identity — the CloudEvent id the adapter derives from
   * (profile, item, kind, eTag). A redelivered change carries the same id, so
   * the append is a no-op: no second row and no second `seq`.
   */
  changeId: z.string().min(1),
  itemId: z.string().min(1),
  kind: stagedChangeKindSchema,
  relativePath: z.string(),
  name: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  s3Key: z.string().min(1).optional(),
  /** The provider's content version. Stored for diagnosis; never a cursor. */
  eTag: z.string().min(1).optional(),
  /** When the consumer recorded the change — the feed's `createdAt`. */
  recordedAt: z.string().min(1),
});

export type StagedChange = z.infer<typeof stagedChangeSchema>;

/** A change to append: everything but the `seq` the log assigns. */
export type StagedChangeInput = Omit<StagedChange, "seq">;

/**
 * The outcome of an append. `duplicate` is the expected result of redelivering
 * a change that was already logged — never an error.
 */
export type AppendOutcome = { status: "appended" } | { status: "duplicate" };

/**
 * Append-only change log over staged records. It owns the change ORDER the
 * delivery surface serves, so no reader orders by `itemId` or by any provider
 * token.
 */
export interface StagedChangeLog {
  /** Appends a change, or reports it as a duplicate when `changeId` is already logged. */
  append(change: StagedChangeInput): Promise<AppendOutcome>;
  /**
   * Rows with `seq` strictly greater than `after`, ascending, at most `limit`.
   * An empty page means the caller has caught up; there is no "more" flag, so
   * a reader always advances its cursor by the rows it actually read.
   */
  read(options: { profileId: string; after?: number; limit?: number }): Promise<StagedChange[]>;
}

/**
 * The sync unit a change belongs to. Under Option 1 a profile IS its own sync
 * unit, so until the subscription registry lands (petroglyph-y5bm.2) its
 * subscription id is its profile id. The adapter fills the field as soon as the
 * registry can name a shared root, which flips the unit without a schema
 * change — this function is the one place that decision lives.
 */
export function subscriptionIdOf(change: {
  profileId: string;
  subscriptionId?: string | undefined;
}): string {
  return change.subscriptionId ?? change.profileId;
}

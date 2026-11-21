import {
  deriveStagingPrefix,
  type StagedIndexStore,
  type StagedObjectStore,
} from "@petroglyph/staging-contracts";

/** Staged rows read and purged per page. */
export const PURGE_PAGE_SIZE = 100;

/**
 * Objects one invocation may delete before it hands the rest back. The handoff
 * is the stream's own redelivery: the record is reported as a batch item
 * failure, DynamoDB Streams delivers it again, and the next pass resumes from
 * the first row that is still there.
 */
export const PURGE_OBJECT_BUDGET = 1000;

/** A purge either finished, or stopped at the budget with work left. */
export type PurgeOutcome = { readonly status: "complete" } | { readonly status: "exhausted" };

export interface ProfilePurgeOptions {
  index: StagedIndexStore;
  objectStore: StagedObjectStore;
  pageSize?: number;
  objectBudget?: number;
  log?: (message: string) => void;
}

/**
 * Deletes everything the staging domain stores for one profile: the staged
 * objects its rows name, then the rows.
 *
 * Per page the objects go first and the rows last, because the rows are the work
 * list — a crash between the two leaves the rows in place and the replay derives
 * the same keys. Deleting a row first would leave an object nothing names.
 *
 * Keys come from the record, as every other reader takes them, and are only
 * deleted when they sit under {@link deriveStagingPrefix} for this profile: a
 * row that names another profile's object is logged and skipped rather than
 * followed.
 *
 * Idempotent: a missing object, a missing row and an empty page are all success,
 * so a redelivered stream record re-runs the same keyed deletes.
 */
export async function purgeStagedStorageForProfile(
  options: ProfilePurgeOptions,
  profileId: string,
): Promise<PurgeOutcome> {
  const pageSize = options.pageSize ?? PURGE_PAGE_SIZE;
  const objectBudget = options.objectBudget ?? PURGE_OBJECT_BUDGET;
  const log = options.log ?? console.warn;
  const prefix = deriveStagingPrefix({ profileId });

  let deletedObjects = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await options.index.queryFeed({
      profileId,
      limit: pageSize,
      ...(cursor === undefined ? {} : { cursor }),
    });

    for (const record of page.records) {
      if (deletedObjects >= objectBudget) {
        return { status: "exhausted" };
      }
      if (!record.s3Key.startsWith(prefix)) {
        log(
          `[profile-purge] staged key outside ${prefix} for ${profileId}, not deleting: ${record.s3Key}`,
        );
        continue;
      }
      await options.objectStore.delete(record.s3Key);
      await options.index.remove(profileId, record.itemId);
      deletedObjects += 1;
    }

    if (page.nextCursor === undefined) {
      return { status: "complete" };
    }
    cursor = page.nextCursor;
  }
}

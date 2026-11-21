import type { StagedRecord } from "./record.js";

/**
 * Index mechanics over staged records. Idempotent by design: upsert is a
 * blind write (same {profileId, itemId} → same record), removes are no-ops
 * when the record is absent.
 */
export interface StagedIndexStore {
  upsert(record: StagedRecord): Promise<void>;
  get(profileId: string, itemId: string): Promise<StagedRecord | null>;
  remove(profileId: string, itemId: string): Promise<void>;
  /**
   * Records whose relativePath is exactly `path` or nested under it — the
   * folder-delete sweep's read set.
   */
  listUnderPath(profileId: string, path: string): Promise<StagedRecord[]>;
  removeUnderPath(profileId: string, path: string): Promise<void>;
}

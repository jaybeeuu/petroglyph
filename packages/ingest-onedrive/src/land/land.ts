import { deriveStagingKey, stage } from "@petroglyph/staging-contracts";
import type { ObjectStore } from "@petroglyph/core";
import type { FileChangeEvent } from "../delta/delta-walk.js";

export async function landBytes(
  store: ObjectStore,
  change: FileChangeEvent,
  body: Uint8Array,
  contentType: string,
): Promise<{ s3Key: string; versionId?: string }> {
  return stage(store, {
    profileId: change.profileId,
    relativePath: change.relativePath,
    name: change.name,
    body,
    contentType,
  });
}

/**
 * Deterministic removal key for a deleted file (same input → same key as the
 * original land). null when derivation is impossible (adapter NEVER deletes
 * S3 objects — Unit 2 acts on the event).
 */
export function deriveRemovedKey(change: FileChangeEvent): string | null {
  try {
    return deriveStagingKey({
      profileId: change.profileId,
      relativePath: change.relativePath,
      name: change.name,
    });
  } catch {
    return null;
  }
}

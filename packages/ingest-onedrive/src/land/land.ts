import {
  deriveStagingKey,
  stage,
  type MimeType,
  type StagedObjectStore,
} from "@petroglyph/staging-contracts";
import type { FileChangeEvent } from "../delta/delta-walk.js";

type FileChange = Extract<FileChangeEvent, { kind: "file" }>;

export async function landBytes(
  store: StagedObjectStore,
  change: Pick<FileChange, "profileId" | "relativePath"> & { name: string },
  body: Uint8Array,
  contentType: MimeType,
): Promise<{ s3Key: string }> {
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
 * original land). null when derivation is impossible — a delete whose name was
 * omitted on the wire, or any other underivable input. The adapter NEVER
 * deletes S3 objects — Unit 2 acts on the event.
 */
export function deriveRemovedKey(change: {
  profileId: string;
  relativePath: string;
  name?: string;
}): string | null {
  if (change.name === undefined) {
    return null;
  }
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

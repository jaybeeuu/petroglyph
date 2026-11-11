import { stage, type MimeType, type StagedObjectStore } from "@petroglyph/staging-contracts";
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

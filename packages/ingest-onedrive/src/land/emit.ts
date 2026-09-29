import { parseCloudEvent, type EventLogWriter } from "@petroglyph/events";
import { fileDeletedEvent, fileStagedEvent } from "@petroglyph/staging-contracts";
import type { FileChangeEvent } from "../delta/delta-walk.js";

type StagedChange = Extract<FileChangeEvent, { kind: "file" }>;
type DeletedChange = Extract<FileChangeEvent, { kind: "deleted" }>;

/** Shared CE subject — the item the event is about. */
function subjectFor(change: { itemId: string }): string {
  return `files/${change.itemId}`;
}

export function emitFileStaged(
  eventLog: EventLogWriter,
  options: {
    change: Pick<StagedChange, "profileId" | "itemId" | "relativePath"> & { name: string };
    s3Key: string;
    mimeType: string;
    emissionId: string;
  },
): Promise<boolean> {
  // changeType is a permanent "created" only until petroglyph-j1gn.17 derives
  // the created-vs-updated distinction from real state.
  const document = parseCloudEvent(
    {
      specversion: "1.0",
      id: options.emissionId,
      source: `onedrive://profiles/${options.change.profileId}`,
      type: "petroglyph.file.staged",
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
      subject: subjectFor(options.change),
      data: {
        profileId: options.change.profileId,
        source: "onedrive",
        changeType: "created",
        itemId: options.change.itemId,
        name: options.change.name,
        relativePath: options.change.relativePath,
        s3Key: options.s3Key,
        mimeType: options.mimeType,
      },
    },
    fileStagedEvent,
  );
  return eventLog.putIfAbsent(document);
}

export function emitFileDeleted(
  eventLog: EventLogWriter,
  options: {
    change: Pick<DeletedChange, "profileId" | "itemId" | "relativePath"> & { name?: string };
    s3Key: string | null;
    emissionId: string;
  },
): Promise<boolean> {
  const document = parseCloudEvent(
    {
      specversion: "1.0",
      id: options.emissionId,
      source: `onedrive://profiles/${options.change.profileId}`,
      type: "petroglyph.file.deleted",
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      dataschema: "https://schemas.petroglyph.dev/file-deleted/v1.json",
      subject: subjectFor(options.change),
      data: {
        profileId: options.change.profileId,
        source: "onedrive",
        changeType: "deleted",
        itemId: options.change.itemId,
        // The REMOVED item's own path (parent + name) — Unit 2 sweeps records
        // under this path, so the path must be the thing itself, not its parent.
        relativePath: deletedOwnPath(options.change),
        s3Key: options.s3Key,
      },
    },
    fileDeletedEvent,
  );
  return eventLog.putIfAbsent(document);
}

/**
 * The deleted thing's own normalized path — parent/name, or name at the root.
 * A deleted item may omit its name on the wire; with no name there is no
 * item-level path, so the parent path is the most specific path we hold.
 */
export function deletedOwnPath(change: { name?: string; relativePath: string }): string {
  if (change.name === undefined) {
    return change.relativePath;
  }
  return change.relativePath === "" ? change.name : `${change.relativePath}/${change.name}`;
}

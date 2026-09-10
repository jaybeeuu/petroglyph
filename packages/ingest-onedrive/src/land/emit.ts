import type { EventLogWriter } from "@petroglyph/events";
import { fileDeletedEvent, fileStagedEvent } from "@petroglyph/staging-contracts";
import type { FileChangeEvent } from "../delta/delta-walk.js";

export function emitFileStaged(
  eventLog: EventLogWriter,
  options: {
    change: Pick<FileChangeEvent, "profileId" | "changeType" | "itemId" | "name" | "relativePath">;
    s3Key: string;
    mimeType: string;
    emissionId: string;
  },
): Promise<boolean> {
  const document = fileStagedEvent.buildDocument({
    id: options.emissionId,
    source: `onedrive://profiles/${options.change.profileId}`,
    subject: `files/${options.change.itemId}`,
    data: {
      profileId: options.change.profileId,
      source: "onedrive",
      changeType: options.change.changeType === "updated" ? "updated" : "created",
      itemId: options.change.itemId,
      name: options.change.name,
      relativePath: options.change.relativePath,
      s3Key: options.s3Key,
      mimeType: options.mimeType,
    },
  });
  return eventLog.putIfAbsent(document);
}

export function emitFileDeleted(
  eventLog: EventLogWriter,
  options: {
    change: Pick<FileChangeEvent, "profileId" | "itemId" | "relativePath">;
    s3Key: string | null;
    emissionId: string;
  },
): Promise<boolean> {
  const document = fileDeletedEvent.buildDocument({
    id: options.emissionId,
    source: `onedrive://profiles/${options.change.profileId}`,
    subject: `files/${options.change.itemId}`,
    data: {
      profileId: options.change.profileId,
      source: "onedrive",
      changeType: "deleted",
      itemId: options.change.itemId,
      relativePath: options.change.relativePath,
      s3Key: options.s3Key,
    },
  });
  return eventLog.putIfAbsent(document);
}

import type { FileChangeEvent } from "../delta/delta-walk.js";

type FileChange = Extract<FileChangeEvent, { kind: "file" }>;

/**
 * Pre-download filter: accept when the vendor mimeType claim OR the filename
 * extension says PDF. This decides the DOWNLOAD only — the bytes verify at
 * land (detectType) and a mismatch logs lie telemetry.
 */
export function passesPreDownloadFilter(change: FileChange): boolean {
  const claimSaysPdf = change.mimeType === "application/pdf";
  const extensionSaysPdf = change.name?.toLowerCase().endsWith(".pdf") ?? false;
  return claimSaysPdf || extensionSaysPdf;
}

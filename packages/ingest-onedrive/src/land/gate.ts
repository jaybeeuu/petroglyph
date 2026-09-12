import type { FileChangeEvent } from "../delta/delta-walk.js";

/**
 * Pre-download filter: accept when the vendor mimeType claim OR the filename
 * extension says PDF. This decides the DOWNLOAD only — the bytes verify at
 * land (detectType) and a mismatch logs lie telemetry.
 */
export function passesPreDownloadFilter(change: FileChangeEvent): boolean {
  const claimSaysPdf = change.mimeType === "application/pdf";
  const extensionSaysPdf = change.name.toLowerCase().endsWith(".pdf");
  return claimSaysPdf || extensionSaysPdf;
}

/**
 * Accepted-type detection for staged bodies: magic-byte signature table.
 * L0 today: PDF only. The detected value is ALWAYS the source of both
 * data.mimeType and the S3 ContentType — a default would store a lie.
 */
export function detectType(body: Uint8Array): string | null {
  if (body.length < 5) {
    return null;
  }
  const signature = new TextDecoder().decode(body.subarray(0, 5));
  return signature === "%PDF-" ? "application/pdf" : null;
}

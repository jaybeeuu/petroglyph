/** S3 layout version — additive evolution only: v2 keys coexist with v1 keys. */
export const STAGING_LAYOUT_VERSION = "v1";

function assertSafeSegment(segment: string, label: string): void {
  if (segment.length === 0) {
    throw new Error(`Staging key ${label} must not be empty`);
  }
  if (segment.startsWith("/")) {
    throw new Error(`Staging key ${label} must not start with a slash`);
  }
  for (const part of segment.split("/")) {
    if (part === "..") {
      throw new Error(`Staging key ${label} must not contain traversal segments`);
    }
    if (part.length === 0) {
      throw new Error(`Staging key ${label} must not contain empty segments`);
    }
  }
}

/**
 * staging/v1/<profileId>/<relativePath>/<name> — the layout version lives in
 * the key so layout changes are additive (never a coordinated deploy).
 * `name` is kept verbatim; no extension surgery.
 */
export function deriveStagingKey(input: {
  profileId: string;
  relativePath: string;
  name: string;
}): string {
  assertSafeSegment(input.profileId, "profileId");
  assertSafeSegment(input.relativePath, "relativePath");
  assertSafeSegment(input.name, "name");

  return `staging/${STAGING_LAYOUT_VERSION}/${input.profileId}/${input.relativePath}/${input.name}`;
}

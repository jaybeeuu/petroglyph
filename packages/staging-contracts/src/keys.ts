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
 * staging/v1/<profileId>/ — everything one profile owns under the staging
 * layout. This is the ONLY place the layout is spelled: keys are derived from
 * it here and nowhere is a prefix built by hand, so a layout change is one
 * edit. The trailing slash makes the prefix a segment boundary, never a
 * partial segment (`p1` cannot match `p10`).
 */
export function deriveStagingPrefix(input: { profileId: string }): string {
  assertSafeSegment(input.profileId, "profileId");

  return `staging/${STAGING_LAYOUT_VERSION}/${input.profileId}/`;
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
  assertSafeSegment(input.relativePath, "relativePath");
  assertSafeSegment(input.name, "name");

  return `${deriveStagingPrefix({ profileId: input.profileId })}${input.relativePath}/${input.name}`;
}

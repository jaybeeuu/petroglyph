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
 * The S3 prefix one sync unit's staged bytes live under. This is the ONE place
 * that spells the layout: adopting a subscription-scoped layout later is a
 * change here plus a re-key, with every input already on the staged record.
 */
export function stagingPrefix(scope: { profileId: string }): string {
  assertSafeSegment(scope.profileId, "profileId");
  return `staging/${STAGING_LAYOUT_VERSION}/${scope.profileId}`;
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

  return `${stagingPrefix({ profileId: input.profileId })}/${input.relativePath}/${input.name}`;
}

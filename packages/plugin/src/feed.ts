import { z } from "zod";

/** One staged file, as the delivery surface's `/files` feed reports it. */
export const feedEntrySchema = z.object({
  itemId: z.string().min(1),
  name: z.string().min(1),
  relativePath: z.string(),
  mimeType: z.string(),
  s3PresignedUrl: z.string().min(1),
  createdAt: z.string().min(1),
});

export type FeedEntry = z.infer<typeof feedEntrySchema>;

/**
 * The `/files` page contract. `nextToken` is the opaque page cursor, or null
 * once the feed is exhausted.
 */
export const filesFeedSchema = z.object({
  files: z.array(feedEntrySchema),
  nextToken: z.string().nullable(),
});

export type FilesFeed = z.infer<typeof filesFeedSchema>;

/** Parses a `/files` response body, or null when it does not match the contract. */
export function parseFilesFeed(payload: unknown): FilesFeed | null {
  const parsed = filesFeedSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** Where one feed entry belongs in the vault, and where its companion note goes. */
export interface VaultPaths {
  pdf: string;
  markdown: string;
}

/**
 * The vault root a profile writes to when its destination is empty. The default
 * lives here, not at each call site, so an install that never set a destination
 * keeps landing files in `handwritten/` and no synced file moves.
 */
export const DEFAULT_VAULT_ROOT = "handwritten";

/**
 * A profile's destination as a vault root, or a rejection when the destination
 * would resolve outside the vault.
 */
export type VaultRoot = { ok: true; root: string } | { ok: false };

/**
 * Canonical form of a profile's `destinationVaultPath`: leading, trailing and
 * repeated slashes are stripped, and inner whitespace is dropped, so `//a//b/`
 * and `a/b` name the same folder. A blank value keeps `DEFAULT_VAULT_ROOT`.
 *
 * A `..` segment is rejected rather than resolved: `..` climbs out of the
 * vault, and a write must never follow it. Every other value is relative to
 * the vault root by construction, so a leading slash is normalised, not an
 * escape.
 */
export function resolveVaultRoot(destinationVaultPath: string | undefined): VaultRoot {
  const segments = (destinationVaultPath ?? "").split("/").flatMap((segment) => {
    const trimmed = segment.trim();
    return trimmed === "" || trimmed === "." ? [] : [trimmed];
  });
  if (segments.includes("..")) return { ok: false };
  return { ok: true, root: segments.length === 0 ? DEFAULT_VAULT_ROOT : segments.join("/") };
}

/**
 * Maps a feed entry onto the vault: the source's `relativePath` is preserved
 * under `root`, so a folder structure in OneDrive survives the trip.
 */
export function vaultPathsFor(root: string, entry: FeedEntry): VaultPaths {
  const directory = entry.relativePath.replace(/^\/+|\/+$/g, "");
  const parent = directory === "" ? root : `${root}/${directory}`;
  const pdf = `${parent}/${entry.name}`.replace(/\/{2,}/g, "/");
  return { pdf, markdown: pdf.replace(/\.pdf$/i, ".md") };
}

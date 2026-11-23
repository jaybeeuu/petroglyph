import { z } from "zod";

/**
 * A profile as the plugin holds it. The name, source path and active flag mirror
 * the server's profile; `destinationVaultPath` is the plugin's own state, since
 * the server neither accepts nor returns a destination. A stored profile that
 * predates the field keeps the `handwritten` root.
 */
export const syncProfileSchema = z.object({
  profileId: z.string(),
  name: z.string(),
  sourceFolderPath: z.string(),
  destinationVaultPath: z.string().default(""),
  active: z.boolean().optional(),
});

export type SyncProfile = z.infer<typeof syncProfileSchema>;

/**
 * The destinations the plugin holds, keyed by profile id. The server neither
 * accepts nor returns a destination, so this map is its only home: `loadProfiles`
 * reads it for every profile it lists, and no profile list read writes to it.
 */
export type ProfileDestinations = { [profileId: string]: string };

const profileDestinationsSchema = z.record(z.string(), z.unknown());

/**
 * The destinations a saved data file holds, or undefined when the field is not a
 * record at all. One entry that is not a string costs only that profile's
 * destination, the way `parseStoredProfiles` tolerates one corrupt record.
 */
export function parseProfileDestinations(raw: unknown): ProfileDestinations | undefined {
  const parsed = profileDestinationsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const destinations: ProfileDestinations = {};
  for (const [profileId, value] of Object.entries(parsed.data)) {
    if (typeof value === "string") destinations[profileId] = value;
  }
  return destinations;
}

/**
 * The profiles a saved data file holds, one entry at a time: a single corrupt
 * record must not cost every other profile the destination it remembers.
 */
export function parseStoredProfiles(raw: unknown): SyncProfile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry) => {
    const parsed = syncProfileSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export interface PluginData {
  apiBaseUrl: string;
  jwt?: string;
  refreshToken?: string;
  username?: string;
  oneDriveConnected?: boolean;
  oneDriveStatus?: string;
  syncIntervalMinutes?: number;
  feedCursors?: { [key: string]: string };
  activeProfileId?: string;
  profiles?: SyncProfile[];
  profileDestinations?: ProfileDestinations;
}

export interface AuthCallbackParams {
  code: string;
  state: string;
}

export interface AuthCallbackResponse {
  jwt: string;
  refreshToken: string;
  username: string;
}

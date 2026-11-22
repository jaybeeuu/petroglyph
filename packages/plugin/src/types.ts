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

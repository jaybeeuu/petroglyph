/**
 * The one empty-profile message. A connected user with no profile has nothing
 * to sync, so both the settings section and a manual sync say the same thing.
 */
export const NO_PROFILES_NOTICE = "No profiles yet - create one to start syncing";

export interface SyncProfile {
  profileId: string;
  name: string;
  sourceFolderPath: string;
  destinationVaultPath: string;
  active?: boolean;
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

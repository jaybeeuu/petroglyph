export interface SyncProfile {
  id: string;
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

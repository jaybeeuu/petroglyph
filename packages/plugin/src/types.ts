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
  /**
   * The version the vault last received for an item, per profile: `{profileId:
   * {itemId: eTag}}`. This is what makes the drain reconcile instead of trust an
   * itemId watermark — an entry whose `eTag` differs is rewritten even when its
   * itemId sorts behind the cursor. Cleared with the cursor by Reset Plugin
   * State (local).
   */
  feedEtags?: { [profileId: string]: { [itemId: string]: string } };
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

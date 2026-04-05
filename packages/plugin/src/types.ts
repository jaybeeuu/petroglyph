export interface PluginData {
  apiBaseUrl: string;
  jwt?: string;
  refreshToken?: string;
  username?: string;
  oneDriveConnected?: boolean;
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

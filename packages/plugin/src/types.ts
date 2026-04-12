export interface PluginData {
  apiBaseUrl: string;
  jwt?: string;
  refreshToken?: string;
  username?: string;
  oneDriveConnected?: boolean;
  oneDriveStatus?: string;
  syncIntervalMinutes?: number;
  changeTokens?: Record<string, string>;
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

export interface FileChange {
  fileId: string;
  s3PresignedUrl: string;
  filename: string;
  createdAt: string;
  pageCount?: number;
}

export interface FilesChangesResponse {
  files: FileChange[];
  nextToken: string | null;
  resetToken?: boolean;
}

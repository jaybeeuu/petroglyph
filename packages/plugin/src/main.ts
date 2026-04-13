import { Notice, Plugin, normalizePath } from "obsidian";
import { PetroglyphSettingTab } from "./settings.js";
import type { AuthCallbackParams, FileChange, PluginData, SyncProfile } from "./types.js";
import { hasStringProp, isRecord } from "./validate.js";

const DEFAULT_DATA: PluginData = {
  apiBaseUrl: "http://localhost:3000",
  syncIntervalMinutes: 5,
  changeTokens: {},
};

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_PROFILE_ID = "default";
const VAULT_ROOT = "handwritten";

function decodeJwtExpiry(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const payloadBase64 = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    const payload: unknown = JSON.parse(atob(payloadBase64));
    if (isRecord(payload) && typeof payload["exp"] === "number") {
      return payload["exp"];
    }
  } catch {
    return null;
  }
  return null;
}

export class PetroglyphPlugin extends Plugin {
  /**
   * Manually trigger a sync: POST /sync/run, then page GET /files/changes until nextToken is null.
   * Shows a notice on completion or error.
   */
  async syncNow(): Promise<void> {
    if (this._data.jwt === undefined || !this._data.oneDriveConnected) {
      new Notice("Not connected. Cannot sync.");
      return;
    }
    try {
      const headers = { Authorization: `Bearer ${this._data.jwt}` };
      const runResp = await fetch(`${this._data.apiBaseUrl}/sync/run`, {
        method: "POST",
        headers,
      });
      if (!runResp.ok) {
        new Notice("Sync failed: could not start sync");
        return;
      }
      // Now page GET /files/changes until nextToken is null
      const profileId = DEFAULT_PROFILE_ID;
      let afterToken = this._data.changeTokens?.[profileId];
      let hasMore = true;
      while (hasMore) {
        const url = new URL(`${this._data.apiBaseUrl}/files/changes`);
        if (afterToken !== undefined) url.searchParams.set("after", afterToken);
        const resp = await fetch(url.toString(), { headers });
        if (!resp.ok) {
          new Notice("Sync failed: error fetching changes");
          return;
        }
        const body: unknown = await resp.json();
        if (!isRecord(body)) {
          new Notice("Sync failed: invalid response");
          return;
        }
        if (body["resetToken"] === true) {
          this._data = {
            ...this._data,
            changeTokens: {
              ...this._data.changeTokens,
              [profileId]: undefined as unknown as string,
            },
          };
          delete this._data.changeTokens?.[profileId];
          await this.savePluginData();
        }
        const files = body["files"];
        if (!Array.isArray(files)) {
          new Notice("Sync failed: invalid files list");
          return;
        }
        for (const file of files) {
          if (!isRecord(file)) continue;
          await this.syncFile(file as unknown as FileChange, profileId);
        }
        const nextToken = body["nextToken"];
        hasMore = typeof nextToken === "string";
        afterToken = hasMore ? (nextToken as string) : undefined;
      }
      new Notice("Sync complete");
    } catch (e) {
      new Notice("Sync failed: network or server error");
    }
  }

  /**
   * Reset plugin state: clear local change token for active profileId only.
   */
  async resetPluginState(): Promise<void> {
    const profileId = DEFAULT_PROFILE_ID;
    if (this._data.changeTokens && this._data.changeTokens[profileId]) {
      this._data = {
        ...this._data,
        changeTokens: {
          ...this._data.changeTokens,
          [profileId]: undefined as unknown as string,
        },
      };
      delete this._data.changeTokens?.[profileId];
      await this.savePluginData();
    }
    new Notice("Plugin state reset: local sync token cleared");
  }

  /**
   * Reset server state: POST /sync/reset {scope: 'server'}; show confirmation notice.
   */
  async resetServerState(): Promise<void> {
    if (this._data.jwt === undefined) {
      new Notice("Not logged in. Cannot reset server state.");
      return;
    }
    try {
      const resp = await fetch(`${this._data.apiBaseUrl}/sync/reset`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._data.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scope: "server" }),
      });
      if (!resp.ok) {
        new Notice("Server reset failed");
        return;
      }
      new Notice("Server state reset");
    } catch {
      new Notice("Server reset failed: network error");
    }
  }

  /**
   * Full reset: POST /sync/reset {scope: 'full'}; clear local token if resetToken in response.
   */
  async fullReset(): Promise<void> {
    if (this._data.jwt === undefined) {
      new Notice("Not logged in. Cannot perform full reset.");
      return;
    }
    try {
      const resp = await fetch(`${this._data.apiBaseUrl}/sync/reset`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._data.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scope: "full" }),
      });
      if (!resp.ok) {
        new Notice("Full reset failed");
        return;
      }
      const body: unknown = await resp.json();
      if (isRecord(body) && body["resetToken"] === true) {
        const profileId = DEFAULT_PROFILE_ID;
        this._data = {
          ...this._data,
          changeTokens: {
            ...this._data.changeTokens,
            [profileId]: undefined as unknown as string,
          },
        };
        delete this._data.changeTokens?.[profileId];
        await this.savePluginData();
      }
      new Notice("Full reset complete");
    } catch {
      new Notice("Full reset failed: network error");
    }
  }

  private _data: PluginData = { ...DEFAULT_DATA };
  private _refreshTimeoutId: number | null = null;
  private _statusPollIntervalId: number | null = null;
  private _syncPollIntervalId: number | null = null;

  get data(): Readonly<PluginData> {
    return this._data;
  }

  setCredentials(jwt: string, refreshToken: string, username: string): void {
    this._data = { ...this._data, jwt, refreshToken, username };
  }

  clearCredentials(): void {
    if (this._statusPollIntervalId !== null) {
      window.clearInterval(this._statusPollIntervalId);
      this._statusPollIntervalId = null;
    }
    if (this._syncPollIntervalId !== null) {
      window.clearInterval(this._syncPollIntervalId);
      this._syncPollIntervalId = null;
    }
    const {
      jwt: _j,
      refreshToken: _rt,
      username: _u,
      oneDriveConnected: _oc,
      oneDriveStatus: _os,
      ...rest
    } = this._data;
    this._data = { ...rest, oneDriveConnected: false };
  }

  setApiBaseUrl(url: string): void {
    this._data = { ...this._data, apiBaseUrl: url };
  }

  setOneDriveConnected(connected: boolean): void {
    this._data = { ...this._data, oneDriveConnected: connected };
  }

  startStatusPolling(): void {
    if (this._statusPollIntervalId !== null) return;
    this._statusPollIntervalId = window.setInterval(() => {
      void this.pollStatus();
    }, 60_000);
  }

  startSyncPolling(): void {
    if (this._syncPollIntervalId !== null) return;
    const intervalMs = (this._data.syncIntervalMinutes ?? 5) * 60 * 1000;
    this._syncPollIntervalId = window.setInterval(() => {
      void this.performSync();
    }, intervalMs);
  }

  scheduleRefresh(jwt: string): void {
    if (this._refreshTimeoutId !== null) {
      window.clearTimeout(this._refreshTimeoutId);
      this._refreshTimeoutId = null;
    }
    const exp = decodeJwtExpiry(jwt);
    if (exp === null) return;
    const delayMs = Math.max(0, exp * 1000 - REFRESH_BUFFER_MS - Date.now());
    this._refreshTimeoutId = window.setTimeout(() => {
      void this.performRefresh();
    }, delayMs);
  }

  async performRefresh(): Promise<void> {
    const { refreshToken, username } = this._data;
    if (refreshToken === undefined || username === undefined) return;
    try {
      const response = await fetch(`${this._data.apiBaseUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!isRecord(body) || !hasStringProp(body, "jwt") || !hasStringProp(body, "refreshToken")) {
        return;
      }
      this.setCredentials(body.jwt, body.refreshToken, username);
      await this.savePluginData();
      this.scheduleRefresh(body.jwt);
    } catch {
      // Network errors are silently ignored; the next scheduled refresh will retry.
    }
  }

  async performSync(): Promise<void> {
    if (this._data.jwt === undefined || !this._data.oneDriveConnected) return;

    try {
      const profileId = DEFAULT_PROFILE_ID;
      let afterToken = this._data.changeTokens?.[profileId];
      let hasMore = true;

      while (hasMore) {
        const url = new URL(`${this._data.apiBaseUrl}/files/changes`);
        if (afterToken !== undefined) {
          url.searchParams.set("after", afterToken);
        }

        const response = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${this._data.jwt}` },
        });

        if (!response.ok) return;

        const body: unknown = await response.json();
        if (!isRecord(body)) return;

        if (body["resetToken"] === true) {
          this._data = {
            ...this._data,
            changeTokens: {
              ...this._data.changeTokens,
              [profileId]: undefined as unknown as string,
            },
          };
          delete this._data.changeTokens?.[profileId];
          await this.savePluginData();
        }

        const files = body["files"];
        if (!Array.isArray(files)) return;

        for (const file of files) {
          if (!isRecord(file)) continue;
          await this.syncFile(file as unknown as FileChange, profileId);
        }

        const nextToken = body["nextToken"];
        hasMore = typeof nextToken === "string";
        afterToken = hasMore ? (nextToken as string) : undefined;
      }
    } catch {
      // Network errors are silently ignored; the next sync will retry.
    }
  }

  async syncFile(file: FileChange, profileId: string): Promise<void> {
    try {
      const pdfResponse = await fetch(file.s3PresignedUrl);
      if (!pdfResponse.ok) return;

      const pdfBytes = await pdfResponse.arrayBuffer();
      const filename = file.filename;
      const pdfPath = normalizePath(`${VAULT_ROOT}/${filename}`);
      const mdPath = pdfPath.replace(/\.pdf$/, ".md");

      const pdfFolder = pdfPath.substring(0, pdfPath.lastIndexOf("/"));
      if (!(await this.app.vault.adapter.exists(pdfFolder))) {
        await this.app.vault.adapter.mkdir(pdfFolder);
      }

      await this.app.vault.adapter.writeBinary(
        pdfPath,
        new Uint8Array(pdfBytes) as unknown as ArrayBuffer,
      );

      const frontmatter = [
        "---",
        "source: onedrive",
        `synced_at: ${new Date().toISOString()}`,
        `created_at: ${file.createdAt}`,
        ...(file.pageCount !== undefined ? [`page_count: ${file.pageCount}`] : []),
        "tags:",
        "  - handwritten",
        "---",
        "",
      ].join("\n");

      await this.app.vault.adapter.write(mdPath, frontmatter);

      this._data = {
        ...this._data,
        changeTokens: {
          ...this._data.changeTokens,
          [profileId]: file.fileId,
        },
      };
      await this.savePluginData();
    } catch {
      // File-level errors are silently ignored; sync continues with next file.
    }
  }

  override async onload(): Promise<void> {
    await this.loadPluginData();
    await this.loadProfiles();

    this.addSettingTab(new PetroglyphSettingTab(this.app, this));

    // Register manual commands
    if (typeof this.addCommand === "function") {
      this.addCommand({
        id: "petroglyph-sync-now",
        name: "Sync Now",
        callback: () => this.syncNow(),
      });
      this.addCommand({
        id: "petroglyph-reset-plugin-state",
        name: "Reset Plugin State (local)",
        callback: () => this.resetPluginState(),
      });
      this.addCommand({
        id: "petroglyph-reset-server-state",
        name: "Reset Server State (remote)",
        callback: () => this.resetServerState(),
      });
      this.addCommand({
        id: "petroglyph-full-reset",
        name: "Full Reset (remote + local)",
        callback: () => this.fullReset(),
      });
    }

    this.registerObsidianProtocolHandler("petroglyph/auth/callback", async (params) => {
      const code = params["code"];
      const state = params["state"];
      if (typeof code !== "string" || typeof state !== "string") {
        new Notice("Login failed: missing code or state");
        return;
      }
      await this.handleAuthCallback({ code, state });
    });

    this.registerObsidianProtocolHandler("petroglyph/oauth/callback", async (params) => {
      const code = params["code"];
      const state = params["state"];
      if (typeof code !== "string" || typeof state !== "string") {
        new Notice("OneDrive connection failed: missing code or state");
        return;
      }
      await this.handleOneDriveCallback({ code, state });
    });

    if (this._data.jwt !== undefined) {
      this.scheduleRefresh(this._data.jwt);
      this.startStatusPolling();
      if (this._data.oneDriveConnected) {
        this.startSyncPolling();
      }
    }
  }

  override onunload(): void {
    if (this._refreshTimeoutId !== null) {
      window.clearTimeout(this._refreshTimeoutId);
      this._refreshTimeoutId = null;
    }
    if (this._statusPollIntervalId !== null) {
      window.clearInterval(this._statusPollIntervalId);
      this._statusPollIntervalId = null;
    }
    if (this._syncPollIntervalId !== null) {
      window.clearInterval(this._syncPollIntervalId);
      this._syncPollIntervalId = null;
    }
  }

  async loadPluginData(): Promise<void> {
    const raw = await this.loadData();
    const saved: Partial<PluginData> = {};
    if (isRecord(raw)) {
      if (hasStringProp(raw, "apiBaseUrl")) saved.apiBaseUrl = raw.apiBaseUrl;
      if (hasStringProp(raw, "jwt")) saved.jwt = raw.jwt;
      if (hasStringProp(raw, "refreshToken")) saved.refreshToken = raw.refreshToken;
      if (hasStringProp(raw, "username")) saved.username = raw.username;
      if (typeof raw["oneDriveConnected"] === "boolean") {
        saved.oneDriveConnected = raw["oneDriveConnected"];
      }
      if (typeof raw["syncIntervalMinutes"] === "number") {
        saved.syncIntervalMinutes = raw["syncIntervalMinutes"];
      }
      if (isRecord(raw["changeTokens"])) {
        saved.changeTokens = raw["changeTokens"] as Record<string, string>;
      }
      if (hasStringProp(raw, "oneDriveStatus")) {
        saved.oneDriveStatus = raw.oneDriveStatus;
      }
      if (hasStringProp(raw, "activeProfileId")) {
        saved.activeProfileId = raw.activeProfileId;
      }
    }
    this._data = { ...DEFAULT_DATA, ...saved };
  }

  async loadProfiles(): Promise<void> {
    if (this._data.jwt === undefined) return;
    try {
      const response = await fetch(`${this._data.apiBaseUrl}/profiles`, {
        headers: { Authorization: `Bearer ${this._data.jwt}` },
      });
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return;
      const profiles = body.filter(isRecord).map((p): SyncProfile => ({
        id: typeof p["id"] === "string" ? p["id"] : "",
        name: typeof p["name"] === "string" ? p["name"] : "",
        sourceFolderPath: typeof p["sourceFolderPath"] === "string" ? p["sourceFolderPath"] : "",
        destinationVaultPath: typeof p["destinationVaultPath"] === "string" ? p["destinationVaultPath"] : "",
        active: p["active"] === true,
      }));
      const activeFromApi = profiles.find((p) => p.active);
      const activeProfileId = activeFromApi !== undefined ? activeFromApi.id : this._data.activeProfileId;
      this._data = { ...this._data, profiles, ...(activeProfileId !== undefined ? { activeProfileId } : {}) };

      // Clean up stale change tokens whose profile IDs no longer exist
      if (this._data.changeTokens !== undefined) {
        const profileIds = new Set(profiles.map((p) => p.id));
        const cleanedTokens: { [key: string]: string } = {};
        for (const [key, val] of Object.entries(this._data.changeTokens)) {
          if (profileIds.has(key)) {
            cleanedTokens[key] = val;
          }
        }
        this._data = { ...this._data, changeTokens: cleanedTokens };
      }

      await this.savePluginData();
    } catch {
      // Network errors are silently ignored.
    }
  }

  async setActiveProfile(id: string): Promise<void> {
    if (this._data.jwt === undefined) return;
    try {
      const response = await fetch(`${this._data.apiBaseUrl}/profiles/${id}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this._data.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ active: true }),
      });
      if (!response.ok) {
        new Notice("Failed to set active profile");
        return;
      }
      const profiles = (this._data.profiles ?? []).map((p) => ({
        ...p,
        active: p.id === id,
      }));
      this._data = { ...this._data, activeProfileId: id, profiles };
      await this.savePluginData();
    } catch {
      new Notice("Failed to set active profile: network error");
    }
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this._data);
  }

  async openAuthUrl(): Promise<void> {
    try {
      const response = await fetch(`${this._data.apiBaseUrl}/auth/url`);
      if (!response.ok) {
        new Notice("Failed to get auth URL");
        return;
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || !hasStringProp(body, "url")) {
        new Notice("Failed to get auth URL");
        return;
      }
      window.open(body.url, "_blank");
    } catch {
      new Notice("Failed to get auth URL");
    }
  }

  async openOneDriveAuthUrl(): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (this._data.jwt !== undefined) {
        headers["Authorization"] = `Bearer ${this._data.jwt}`;
      }
      const response = await fetch(`${this._data.apiBaseUrl}/onedrive/auth-url`, { headers });
      if (!response.ok) {
        new Notice("Failed to get OneDrive auth URL");
        return;
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || !hasStringProp(body, "url")) {
        new Notice("Failed to get OneDrive auth URL");
        return;
      }
      window.open(body.url, "_blank");
    } catch {
      new Notice("Failed to get OneDrive auth URL");
    }
  }

  async handleOneDriveCallback(params: { code: string; state: string }): Promise<void> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this._data.jwt !== undefined) {
        headers["Authorization"] = `Bearer ${this._data.jwt}`;
      }
      const response = await fetch(`${this._data.apiBaseUrl}/onedrive/connect`, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      });
      if (!response.ok) {
        new Notice("OneDrive connection failed");
        return;
      }
      this.setOneDriveConnected(true);
      await this.savePluginData();
      this.startSyncPolling();
      new Notice("OneDrive connected");
    } catch {
      new Notice("OneDrive connection failed");
    }
  }

  async pollStatus(): Promise<void> {
    if (this._data.jwt === undefined) return;
    try {
      const response = await fetch(`${this._data.apiBaseUrl}/status`, {
        headers: { Authorization: `Bearer ${this._data.jwt}` },
      });
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!isRecord(body)) return;
      const oneDrive = body["oneDrive"];
      if (isRecord(oneDrive)) {
        if (typeof oneDrive["connected"] === "boolean") {
          this.setOneDriveConnected(oneDrive["connected"]);
        }
        if (typeof oneDrive["status"] === "string") {
          this._data = { ...this._data, oneDriveStatus: oneDrive["status"] };
        }
        await this.savePluginData();
      }
    } catch {
      // Network errors are silently ignored; the next poll will retry.
    }
  }

  async handleAuthCallback(params: AuthCallbackParams): Promise<void> {
    try {
      const response = await fetch(`${this._data.apiBaseUrl}/auth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        new Notice("Login failed");
        return;
      }

      const body: unknown = await response.json();
      if (!isRecord(body)) {
        new Notice("Login failed");
        return;
      }
      if (
        !hasStringProp(body, "jwt") ||
        !hasStringProp(body, "refreshToken") ||
        !hasStringProp(body, "username")
      ) {
        new Notice("Login failed");
        return;
      }
      this.setCredentials(body.jwt, body.refreshToken, body.username);
      await this.savePluginData();
      this.scheduleRefresh(body.jwt);
      this.startStatusPolling();
      new Notice(`Logged in as @${body.username}`);
    } catch {
      new Notice("Login failed");
    }
  }
}

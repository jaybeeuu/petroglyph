import { Notice, Plugin } from "obsidian";
import { z } from "zod";
import { parseFilesFeed, vaultPathsFor } from "./feed.js";
import type { FeedEntry } from "./feed.js";
import { PetroglyphSettingTab } from "./settings.js";
import type { PluginData, SyncProfile } from "./types.js";
import { hasStringProp, isRecord } from "./validate.js";

const DEFAULT_DATA: PluginData = {
  apiBaseUrl: "https://api.petroglyph.page",
  syncIntervalMinutes: 5,
  feedCursors: {},
};

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_PROFILE_ID = "default";
const VAULT_ROOT = "handwritten";

const jwtPayloadSchema = z.object({
  exp: z.number(),
});

/** Why a feed drain stopped early. */
export type FeedDrainFailure = "rejected" | "invalid" | "network" | "stalled";

/** Outcome of draining the `/files` feed. */
export type FeedDrain = { ok: true } | { ok: false; reason: FeedDrainFailure };

/**
 * Pages one drain may request before giving up. A feed whose cursor stops
 * advancing would otherwise hang the plugin forever, every poll interval.
 */
export const MAX_FEED_PAGES = 200;

/** The notice a failed drain shows when the user asked for it explicitly. */
const FEED_FAILURE_NOTICES: { [reason in FeedDrainFailure]: string } = {
  rejected: "Sync failed: error fetching files",
  invalid: "Sync failed: invalid files list",
  network: "Sync failed: network or server error",
  stalled: "Sync failed: files feed did not finish",
};

/** The companion note body written beside a synced PDF. */
function companionNote(entry: FeedEntry): string {
  return [
    "---",
    "source: onedrive",
    `synced_at: ${new Date().toISOString()}`,
    `created_at: ${entry.createdAt}`,
    "tags:",
    "  - handwritten",
    "---",
    "",
  ].join("\n");
}

function decodeJwtExpiry(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new TypeError(`Expected a JWT with three parts but found ${parts.length}.`);
  }
  const payloadBase64 = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const payload = jwtPayloadSchema.parse(JSON.parse(atob(payloadBase64)));
  return payload.exp;
}

export type PluginEventType = "state-changed";

export type PluginEventHandler = () => void;

export class PetroglyphPlugin extends Plugin {
  private readonly _listeners: Map<PluginEventType, Set<PluginEventHandler>> = new Map();

  on(event: PluginEventType, handler: PluginEventHandler): void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)?.add(handler);
  }

  off(event: PluginEventType, handler: PluginEventHandler): void {
    this._listeners.get(event)?.delete(handler);
  }

  private emit(event: PluginEventType): void {
    for (const handler of this._listeners.get(event) ?? []) {
      handler();
    }
  }
  /**
   * Manually sync the vault: drain GET /files from the stored cursor and report
   * the outcome. The server-side trigger is not this call's business — a
   * catch-up bell makes new files appear in the feed.
   */
  async syncNow(): Promise<void> {
    if (this._data.jwt === undefined || !this._data.oneDriveConnected) {
      new Notice("Not connected. Cannot sync.");
      return;
    }
    const drain = await this.drainFilesFeed(this.resolveProfileId());
    if (drain.ok) {
      new Notice("Sync complete");
      return;
    }
    new Notice(FEED_FAILURE_NOTICES[drain.reason]);
  }

  /** The profile whose feed cursor and files feed paging are used; falls back to "default". */
  private resolveProfileId(): string {
    return this._data.activeProfileId ?? DEFAULT_PROFILE_ID;
  }

  /**
   * Pages GET /files from the profile's stored cursor until the feed is
   * exhausted, writing each entry into the vault. A cursor the feed rejects
   * (400) is stale: it is cleared and the drain restarts once from the head of
   * the feed, so a bad cursor can never wedge syncing.
   */
  private async drainFilesFeed(profileId: string): Promise<FeedDrain> {
    const jwt = this._data.jwt;
    if (jwt === undefined) return { ok: false, reason: "rejected" };

    const headers = { Authorization: `Bearer ${jwt}` };
    let cursor = this._data.feedCursors?.[profileId];
    let retriedRejectedCursor = false;

    for (let page = 0; ; page += 1) {
      if (page >= MAX_FEED_PAGES) return { ok: false, reason: "stalled" };

      const url = new URL(`${this._data.apiBaseUrl}/files`);
      if (cursor !== undefined) url.searchParams.set("after", cursor);

      let response: Response;
      try {
        response = await fetch(url.toString(), { headers });
      } catch {
        return { ok: false, reason: "network" };
      }

      if (response.status === 400 && !retriedRejectedCursor) {
        retriedRejectedCursor = true;
        await this.saveFeedCursor(profileId, undefined);
        cursor = undefined;
        continue;
      }
      if (!response.ok) return { ok: false, reason: "rejected" };

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, reason: "invalid" };
      }
      const feed = parseFilesFeed(payload);
      if (feed === null) return { ok: false, reason: "invalid" };

      for (const entry of feed.files) {
        await this.writeFeedEntry(entry);
      }

      await this.saveFeedCursor(profileId, feed.nextToken ?? undefined);
      if (feed.nextToken === null) return { ok: true };
      cursor = feed.nextToken;
    }
  }

  /** Stores the profile's feed cursor; `undefined` forgets it. */
  private async saveFeedCursor(profileId: string, cursor: string | undefined): Promise<void> {
    const cursors: { [key: string]: string } = {};
    for (const [key, value] of Object.entries(this._data.feedCursors ?? {})) {
      if (key !== profileId) cursors[key] = value;
    }
    if (cursor !== undefined) cursors[profileId] = cursor;
    this._data = { ...this._data, feedCursors: cursors };
    await this.savePluginData();
  }

  /**
   * Writes one staged file into the vault, plus its companion note. An entry
   * whose bytes already match the vault file is skipped, so a repeated poll
   * does not churn the note's timestamps.
   */
  private async writeFeedEntry(entry: FeedEntry): Promise<void> {
    try {
      const response = await fetch(entry.s3PresignedUrl);
      if (!response.ok) return;
      const bytes = new Uint8Array(await response.arrayBuffer());

      const paths = vaultPathsFor(VAULT_ROOT, entry);
      const folder = paths.pdf.substring(0, paths.pdf.lastIndexOf("/"));
      if (folder !== "" && !(await this.app.vault.adapter.exists(folder))) {
        await this.app.vault.adapter.mkdir(folder);
      }

      if (await this.isCurrentFile(paths.pdf, bytes)) return;

      await this.app.vault.adapter.writeBinary(paths.pdf, bytes as unknown as ArrayBuffer);
      if (paths.markdown !== paths.pdf) {
        await this.app.vault.adapter.write(paths.markdown, companionNote(entry));
      }
    } catch {
      // File-level errors are ignored; sync continues with the next entry.
    }
  }

  /** True when the vault already holds exactly these bytes at `path`. */
  private async isCurrentFile(path: string, bytes: Uint8Array): Promise<boolean> {
    try {
      const existing = new Uint8Array(await this.app.vault.adapter.readBinary(path));
      if (existing.byteLength !== bytes.byteLength) return false;
      for (let index = 0; index < bytes.byteLength; index += 1) {
        if (existing[index] !== bytes[index]) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reset plugin state: forget the feed cursor for the active profile only, so
   * the next sync re-enumerates the feed from the head.
   */
  async resetPluginState(): Promise<void> {
    if (this._data.feedCursors?.[DEFAULT_PROFILE_ID] !== undefined) {
      await this.saveFeedCursor(DEFAULT_PROFILE_ID, undefined);
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
        await this.saveFeedCursor(DEFAULT_PROFILE_ID, undefined);
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
  private _settingTab: PetroglyphSettingTab | null = null;

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

  refreshSettingsUi(): void {
    this.emit("state-changed");
    this._settingTab?.display();
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
    let exp: number;
    try {
      exp = decodeJwtExpiry(jwt);
    } catch {
      new Notice("Invalid session token: please sign in again.");
      return;
    }
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

    await this.drainFilesFeed(this.resolveProfileId());
  }

  override async onload(): Promise<void> {
    await this.loadPluginData();
    await this.loadProfiles();

    this._settingTab = new PetroglyphSettingTab(this.app, this);
    this.addSettingTab(this._settingTab);

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
      const jwt = params["jwt"];
      const refreshToken = params["refreshToken"];
      const username = params["username"];
      if (
        typeof jwt !== "string" ||
        typeof refreshToken !== "string" ||
        typeof username !== "string"
      ) {
        new Notice("Login failed: missing auth params");
        return;
      }
      this.setCredentials(jwt, refreshToken, username);
      await this.savePluginData();
      this.refreshSettingsUi();
      this.scheduleRefresh(jwt);
      this.startStatusPolling();
      new Notice(`Logged in as @${username}`);
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
    const raw: unknown = await this.loadData();
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
      // `changeTokens` is the pre-/files field name; keep reading it so an
      // upgrade does not lose the cursor and re-download the whole vault.
      const savedCursors = raw["feedCursors"] ?? raw["changeTokens"];
      if (isRecord(savedCursors)) {
        saved.feedCursors = savedCursors as { [key: string]: string };
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
      const profiles = body.filter(isRecord).map(
        (p): SyncProfile => ({
          id: typeof p["id"] === "string" ? p["id"] : "",
          name: typeof p["name"] === "string" ? p["name"] : "",
          sourceFolderPath: typeof p["sourceFolderPath"] === "string" ? p["sourceFolderPath"] : "",
          destinationVaultPath:
            typeof p["destinationVaultPath"] === "string" ? p["destinationVaultPath"] : "",
          active: p["active"] === true,
        }),
      );
      const activeFromApi = profiles.find((p) => p.active);
      const activeProfileId =
        activeFromApi !== undefined ? activeFromApi.id : this._data.activeProfileId;
      this._data = {
        ...this._data,
        profiles,
        ...(activeProfileId !== undefined ? { activeProfileId } : {}),
      };

      // Clean up cursors whose profile IDs no longer exist
      if (this._data.feedCursors !== undefined) {
        const profileIds = new Set(profiles.map((p) => p.id));
        const cleanedCursors: { [key: string]: string } = {};
        for (const [key, val] of Object.entries(this._data.feedCursors)) {
          if (profileIds.has(key)) {
            cleanedCursors[key] = val;
          }
        }
        this._data = { ...this._data, feedCursors: cleanedCursors };
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

  async createProfile(data: {
    name: string;
    sourceFolderPath: string;
    destinationVaultPath: string;
  }): Promise<void> {
    if (this._data.jwt === undefined) return;
    try {
      const response = await fetch(`${this._data.apiBaseUrl}/profiles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._data.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        new Notice("Failed to create profile");
        return;
      }
      await this.loadProfiles();
    } catch {
      new Notice("Failed to create profile: network error");
    }
  }

  async editProfile(
    profileId: string,
    updates: Partial<Pick<SyncProfile, "name" | "sourceFolderPath" | "destinationVaultPath">>,
  ): Promise<void> {
    if (this._data.jwt === undefined) return;
    try {
      const response = await fetch(`${this._data.apiBaseUrl}/profiles/${profileId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this._data.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updates),
      });
      if (!response.ok) {
        new Notice("Failed to edit profile");
        return;
      }
      await this.loadProfiles();
    } catch {
      new Notice("Failed to edit profile: network error");
    }
  }

  async deleteProfile(profileId: string): Promise<void> {
    if (this._data.jwt === undefined) return;
    try {
      const response = await fetch(`${this._data.apiBaseUrl}/profiles/${profileId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this._data.jwt}`,
        },
      });
      if (!response.ok) {
        new Notice("Failed to delete profile");
        return;
      }
      if (this._data.activeProfileId === profileId) {
        const data = { ...this._data };
        delete data.activeProfileId;
        this._data = data;
      }
      await this.loadProfiles();
    } catch {
      new Notice("Failed to delete profile: network error");
    }
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this._data);
  }

  async openAuthUrl(): Promise<void> {
    try {
      const returnUri = "obsidian://petroglyph/auth/callback";
      const response = await fetch(
        `${this._data.apiBaseUrl}/auth/url?returnUri=${encodeURIComponent(returnUri)}`,
      );
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
      const headers: { [key: string]: string } = {};
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
      const headers: { [key: string]: string } = { "Content-Type": "application/json" };
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
      this._data = { ...this._data, oneDriveStatus: "connected" };
      await this.savePluginData();
      this.refreshSettingsUi();
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
      let stateChanged = false;
      const oneDrive = body["oneDrive"];
      if (isRecord(oneDrive)) {
        if (typeof oneDrive["connected"] === "boolean") {
          if (this._data.oneDriveConnected !== oneDrive["connected"]) {
            this.setOneDriveConnected(oneDrive["connected"]);
            stateChanged = true;
          }
        }
        if (typeof oneDrive["status"] === "string") {
          if (this._data.oneDriveStatus !== oneDrive["status"]) {
            this._data = { ...this._data, oneDriveStatus: oneDrive["status"] };
            stateChanged = true;
          }
        }
      }
      if (typeof body["oneDriveStatus"] === "string") {
        if (this._data.oneDriveStatus !== body["oneDriveStatus"]) {
          this._data = { ...this._data, oneDriveStatus: body["oneDriveStatus"] };
          stateChanged = true;
        }
      }
      if (!stateChanged) {
        return;
      }
      await this.savePluginData();
      this.refreshSettingsUi();
    } catch {
      // Network errors are silently ignored; the next poll will retry.
    }
  }
}

export default PetroglyphPlugin;

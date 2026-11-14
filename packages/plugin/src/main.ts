import { Notice, Plugin } from "obsidian";
import { z } from "zod";
import { parseFilesFeed, resolveVaultRoot, vaultPathsFor } from "./feed.js";
import type { FeedEntry } from "./feed.js";
import {
  LOG_PATH,
  PluginLog,
  appLogSink,
  appVaultAdapter,
  describeError,
  logAbsolutePath,
  revealInOs,
} from "./log.js";
import { PetroglyphSettingTab } from "./settings.js";
import type { PluginData, SyncProfile } from "./types.js";
import { hasStringProp, isRecord } from "./validate.js";

const DEFAULT_DATA: PluginData = {
  apiBaseUrl: "https://api.petroglyph.page",
  syncIntervalMinutes: 5,
  feedCursors: {},
  feedEtags: {},
};

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_PROFILE_ID = "default";
const LOG_FLUSH_INTERVAL_MS = 2000;

const jwtPayloadSchema = z.object({
  exp: z.number(),
});

/** Why a feed drain stopped early. */
export type FeedDrainFailure =
  | "rejected"
  | "invalid"
  | "network"
  | "stalled"
  | "destination"
  | "files";

/** Failures whose notice does not depend on how many files failed. */
type FeedFailure = Exclude<FeedDrainFailure, "files">;

/** Outcome of draining the `/files` feed: how many files synced, and how many failed. */
export type FeedDrain = { synced: number; failed: number } & (
  | { ok: true }
  | { ok: false; reason: FeedDrainFailure }
);

/**
 * Pages one drain may request before giving up. A feed whose cursor stops
 * advancing would otherwise hang the plugin forever, every poll interval.
 */
export const MAX_FEED_PAGES = 200;

/** The notice a failed drain shows when the user asked for it explicitly. */
const FEED_FAILURE_NOTICES: { [reason in FeedFailure]: string } = {
  rejected: "Sync failed: error fetching files",
  invalid: "Sync failed: invalid files list",
  network: "Sync failed: network or server error",
  stalled: "Sync failed: files feed did not finish",
  destination: "Sync failed: destination path is not inside the vault",
};

/** The notice shown when some files failed to download or write. */
function fileFailureNotice(synced: number, failed: number): string {
  const attempted = synced + failed;
  if (synced === 0) return `Sync failed: ${failed} of ${attempted} files failed`;
  return `Sync complete: ${synced} ${synced === 1 ? "file" : "files"}, ${failed} failed`;
}

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

/**
 * Records a version the vault now holds. An entry that carried no version records
 * nothing, so that item is compared by its bytes on the next drain — an absent
 * version must never be read back as "unchanged".
 */
function recordVersion(
  seen: { [itemId: string]: string },
  itemId: string,
  eTag: string | undefined,
): void {
  if (eTag !== undefined) seen[itemId] = eTag;
}

/**
 * The saved `{profileId: {itemId: eTag}}` map, keeping only string pairs. The
 * state is local and hand-editable, so it is parsed rather than trusted.
 */
function parseFeedEtags(raw: unknown): { [profileId: string]: { [itemId: string]: string } } {
  const etags: { [profileId: string]: { [itemId: string]: string } } = {};
  if (!isRecord(raw)) return etags;
  for (const [profileId, byItem] of Object.entries(raw)) {
    if (!isRecord(byItem)) continue;
    const items: { [itemId: string]: string } = {};
    for (const [itemId, eTag] of Object.entries(byItem)) {
      if (typeof eTag === "string" && eTag !== "") items[itemId] = eTag;
    }
    if (Object.keys(items).length > 0) etags[profileId] = items;
  }
  return etags;
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
    // Snapshot the subscribers: a handler may subscribe or unsubscribe while it
    // runs, and iterating the live set would visit the newly added handler
    // inside the same emission — an unbounded re-entrant render loop.
    for (const handler of [...(this._listeners.get(event) ?? [])]) {
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
    await this._log.flush();
    if (drain.ok) {
      new Notice("Sync complete");
      return;
    }
    if (drain.reason === "files") {
      new Notice(fileFailureNotice(drain.synced, drain.failed));
      return;
    }
    new Notice(FEED_FAILURE_NOTICES[drain.reason]);
  }

  /** The profile whose feed cursor and files feed paging are used; falls back to "default". */
  private resolveProfileId(): string {
    return this._data.activeProfileId ?? DEFAULT_PROFILE_ID;
  }

  /** The loaded profile a feed is scoped to, if its data has been fetched yet. */
  private profileFor(profileId: string): SyncProfile | undefined {
    return this._data.profiles?.find((profile) => profile.id === profileId);
  }

  /**
   * Pages GET /files from the profile's stored cursor until the feed is
   * exhausted, writing each entry into the vault. A page whose files failed
   * does not advance the cursor, so the next poll retries those files. A cursor
   * the feed rejects (400) is stale: it is cleared and the drain restarts once
   * from the head of the feed, so a bad cursor can never wedge syncing.
   */
  private async drainFilesFeed(profileId: string): Promise<FeedDrain> {
    const jwt = this._data.jwt;
    if (jwt === undefined) return { ok: false, reason: "rejected", synced: 0, failed: 0 };

    // The destination comes from the profile this feed is scoped to, so the
    // files land where the settings UI promised. A destination that escapes the
    // vault stops the drain before the first write.
    const destinationVaultPath = this.profileFor(profileId)?.destinationVaultPath;
    const destination = resolveVaultRoot(destinationVaultPath);
    if (!destination.ok) {
      this._log.error("feed", "destination rejected", { path: destinationVaultPath ?? "" });
      return { ok: false, reason: "destination", synced: 0, failed: 0 };
    }

    const headers = { Authorization: `Bearer ${jwt}` };
    let cursor = this._data.feedCursors?.[profileId];
    // A drain that starts at the head re-reads every item the profile holds, so
    // what it sees is the whole served set: pruning the recorded versions to it
    // bounds the map and drops items that were deleted. A drain resumed mid-feed
    // only adds what it sees and keeps the rest.
    let startedAtHead = cursor === undefined;
    const recordedEtags = this.feedEtagsFor(profileId);
    const seenEtags: { [itemId: string]: string } = {};
    let retriedRejectedCursor = false;
    let synced = 0;
    let failed = 0;

    /** Saves this drain's progress: the versions it confirmed and, when it has one, its cursor. */
    const saveProgress = async (nextCursor: string | undefined): Promise<void> => {
      const etags = startedAtHead ? seenEtags : { ...recordedEtags, ...seenEtags };
      await this.saveFeedState(profileId, {
        ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
        etags,
      });
    };

    for (let page = 0; ; page += 1) {
      if (page >= MAX_FEED_PAGES) return { ok: false, reason: "stalled", synced, failed };

      const url = new URL(`${this._data.apiBaseUrl}/files`);
      if (cursor !== undefined) url.searchParams.set("nextToken", cursor);

      let response: Response;
      try {
        response = await fetch(url.toString(), { headers });
      } catch (error) {
        this.logFeedFailure("network", describeError(error));
        return { ok: false, reason: "network", synced, failed };
      }
      this.logFeedRequest(url, response.status);

      if (response.status === 400 && !retriedRejectedCursor) {
        retriedRejectedCursor = true;
        await this.saveFeedState(profileId, { etags: recordedEtags });
        cursor = undefined;
        // The retry starts at the head, so its seen set is the whole profile.
        startedAtHead = true;
        continue;
      }
      if (!response.ok) {
        this.logFeedFailure("rejected", `status ${String(response.status)}`);
        return { ok: false, reason: "rejected", synced, failed };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, reason: "invalid", synced, failed };
      }
      const feed = parseFilesFeed(payload);
      if (feed === null) {
        this.logFeedFailure("invalid");
        return { ok: false, reason: "invalid", synced, failed };
      }
      this.logFeedPage(feed.files.length, feed.nextToken);

      for (const entry of feed.files) {
        const outcome = await this.writeFeedEntry(entry, destination.root, {
          recorded: recordedEtags,
          seen: seenEtags,
        });
        if (outcome === "failed") failed += 1;
        else synced += 1;
      }

      // A page whose files failed must not advance the cursor, but the versions it
      // did confirm are kept, so those files are not downloaded again.
      if (failed > 0) {
        await saveProgress(cursor);
        return { ok: false, reason: "files", synced, failed };
      }

      await saveProgress(feed.nextToken ?? undefined);
      if (feed.nextToken === null) return { ok: true, synced, failed };
      cursor = feed.nextToken;
    }
  }

  /** The versions the vault holds for one profile, or an empty map. */
  private feedEtagsFor(profileId: string): { [itemId: string]: string } {
    return this._data.feedEtags?.[profileId] ?? {};
  }

  /**
   * Stores one profile's feed progress: its itemId cursor and the versions the
   * vault holds. Both live in the same saved data, so Reset Plugin State (local)
   * clears them together — a reset that kept the versions would skip every
   * rewrite the re-enumeration was meant to make. An `undefined` cursor forgets
   * the cursor; an empty version map forgets the versions.
   */
  private async saveFeedState(
    profileId: string,
    state: { cursor?: string; etags: { [itemId: string]: string } },
  ): Promise<void> {
    const cursors: { [key: string]: string } = {};
    for (const [key, value] of Object.entries(this._data.feedCursors ?? {})) {
      if (key !== profileId) cursors[key] = value;
    }
    if (state.cursor !== undefined) cursors[profileId] = state.cursor;

    const etags: { [profileId: string]: { [itemId: string]: string } } = {};
    for (const [key, value] of Object.entries(this._data.feedEtags ?? {})) {
      if (key !== profileId) etags[key] = value;
    }
    if (Object.keys(state.etags).length > 0) etags[profileId] = state.etags;

    this._data = { ...this._data, feedCursors: cursors, feedEtags: etags };
    await this.savePluginData();
  }

  /**
   * Writes one staged file into the vault, plus its companion note. An entry
   * whose version the vault already holds is skipped without a download, and an
   * entry whose bytes already match the vault file is skipped without a write,
   * so neither a repeated poll nor a metadata-only change churns the file. An
   * entry whose path would leave the vault is rejected before anything is
   * downloaded or written, and a failed entry is reported, never thrown: one bad
   * file must not abort the rest of the page.
   */
  private async writeFeedEntry(
    entry: FeedEntry,
    root: string,
    versions: {
      /** The version the vault received the last time this item was served. */
      recorded: { [itemId: string]: string };
      /** The versions this drain has confirmed, saved as the new local state. */
      seen: { [itemId: string]: string };
    },
  ): Promise<"synced" | "failed"> {
    const mapping = vaultPathsFor(root, entry);
    if (!mapping.ok) {
      this.logVault("rejected: outside the vault", entry.relativePath);
      return "failed";
    }
    const paths = mapping.paths;
    const eTag = entry.eTag;
    try {
      // The version says "changed"; the bytes still say "rewrite". A version the
      // vault already holds skips the download, unless the vault file has gone
      // missing — then the file must be fetched again whatever the version says.
      if (
        eTag !== undefined &&
        versions.recorded[entry.itemId] === eTag &&
        (await this.app.vault.adapter.exists(paths.pdf))
      ) {
        this.logVault("skipped unchanged version", paths.pdf);
        versions.seen[entry.itemId] = eTag;
        return "synced";
      }

      const startedAt = Date.now();
      const response = await fetch(entry.s3PresignedUrl);
      this.logDownloadFailure(entry, startedAt, response);
      if (!response.ok) return "failed";
      const bytes = new Uint8Array(await response.arrayBuffer());
      this.logDownloadComplete(entry, startedAt, response.status, bytes.byteLength);

      const folder = paths.pdf.substring(0, paths.pdf.lastIndexOf("/"));
      if (folder !== "" && !(await this.app.vault.adapter.exists(folder))) {
        await this.app.vault.adapter.mkdir(folder);
      }

      if (await this.isCurrentFile(paths.pdf, bytes)) {
        this.logVault("skipped identical", paths.pdf);
        recordVersion(versions.seen, entry.itemId, eTag);
        return "synced";
      }

      await this.app.vault.adapter.writeBinary(paths.pdf, bytes as unknown as ArrayBuffer);
      this.logVault("wrote", paths.pdf);
      if (paths.markdown !== paths.pdf) {
        await this.app.vault.adapter.write(paths.markdown, companionNote(entry));
      }
      recordVersion(versions.seen, entry.itemId, eTag);
      return "synced";
    } catch (error) {
      this.logDownloadError(entry, error);
      // File-level errors are ignored; sync continues with the next entry.
      return "failed";
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
   * Reset plugin state: forget the feed cursor AND the recorded versions for the
   * active profile only, so the next sync re-enumerates the feed from the head
   * and rewrites whatever the bytes say changed. Keeping the versions would make
   * the reset skip every rewrite it exists to cause.
   */
  async resetPluginState(): Promise<void> {
    const hasRecordedState =
      this._data.feedCursors?.[DEFAULT_PROFILE_ID] !== undefined ||
      Object.keys(this._data.feedEtags?.[DEFAULT_PROFILE_ID] ?? {}).length > 0;
    if (hasRecordedState) {
      await this.saveFeedState(DEFAULT_PROFILE_ID, { etags: {} });
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
        await this.saveFeedState(DEFAULT_PROFILE_ID, { etags: {} });
      }
      new Notice("Full reset complete");
    } catch {
      new Notice("Full reset failed: network error");
    }
  }

  private readonly _log = new PluginLog({ sink: () => appLogSink(this.app) });
  private _data: PluginData = { ...DEFAULT_DATA };
  private _refreshTimeoutId: number | null = null;
  private _statusPollIntervalId: number | null = null;
  private _syncPollIntervalId: number | null = null;
  private _logFlushIntervalId: number | null = null;

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
      if (!response.ok) {
        this._log.warn("auth", "refresh rejected", { status: response.status });
        return;
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || !hasStringProp(body, "jwt") || !hasStringProp(body, "refreshToken")) {
        this._log.warn("auth", "refresh response invalid");
        return;
      }
      this.setCredentials(body.jwt, body.refreshToken, username);
      await this.savePluginData();
      this.scheduleRefresh(body.jwt);
    } catch (error) {
      // The next scheduled refresh retries; the log records why this one failed.
      this._log.warn("auth", "refresh failed", { error: describeError(error) });
    }
  }

  async performSync(): Promise<void> {
    if (this._data.jwt === undefined || !this._data.oneDriveConnected) return;

    await this.drainFilesFeed(this.resolveProfileId());
    await this._log.flush();
  }

  override async onload(): Promise<void> {
    await this.loadPluginData();
    await this.loadProfiles();

    await this.logStartup();
    this.startLogFlushing();

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
      this.addCommand({
        id: "petroglyph-open-log",
        name: "Open log",
        callback: () => {
          void this.openLog();
        },
      });
      this.addCommand({
        id: "petroglyph-copy-diagnostics",
        name: "Copy diagnostics",
        callback: () => {
          void this.copyDiagnostics();
        },
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
        this._log.error("auth", "login failed", { reason: "missing auth params" });
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
        this._log.error("auth", "onedrive connect failed", { reason: "missing code or state" });
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
    if (this._logFlushIntervalId !== null) {
      window.clearInterval(this._logFlushIntervalId);
      this._logFlushIntervalId = null;
    }
    void this._log.flush();
  }

  /** Logs the state a fresh session needs to interpret the log file. */
  private async logStartup(): Promise<void> {
    const manifest: unknown = this.manifest;
    this._log.info("startup", "plugin loaded", {
      version:
        isRecord(manifest) && typeof manifest["version"] === "string"
          ? manifest["version"]
          : "unknown",
      apiBaseUrl: this._data.apiBaseUrl,
      activeProfileId: this.resolveProfileId(),
      oneDriveStatus: this._data.oneDriveStatus ?? "unknown",
      cursors: Object.keys(this._data.feedCursors ?? {}).length,
    });
    await this._log.flush();
  }

  /** Writes buffered log lines on a timer; the end of a drain also flushes. */
  private startLogFlushing(): void {
    if (this._logFlushIntervalId !== null) return;
    this._logFlushIntervalId = window.setInterval(() => {
      void this._log.flush();
    }, LOG_FLUSH_INTERVAL_MS);
  }

  /** Logs one feed request: its URL, the cursor it carried, and the status. */
  private logFeedRequest(url: URL, status: number): void {
    this._log.info("feed", "requested", {
      url: url.toString(),
      cursor: url.searchParams.get("nextToken") ?? "head",
      status,
    });
  }

  /** Logs what one feed page delivered. */
  private logFeedPage(files: number, nextToken: string | null): void {
    this._log.info("feed", "page", { files, nextToken: nextToken ?? "end" });
  }

  /** Logs why a drain stopped, so the failure is never silent. */
  private logFeedFailure(reason: FeedDrainFailure, error?: string): void {
    this._log.error("feed", "drain stopped", { reason, error });
  }

  /** Logs a download that did not return a success status. */
  private logDownloadFailure(entry: FeedEntry, startedAt: number, response: Response): void {
    if (response.ok) return;
    this._log.error("download", "download failed", {
      itemId: entry.itemId,
      url: entry.s3PresignedUrl,
      status: response.status,
      bytes: 0,
      elapsedMs: Date.now() - startedAt,
    });
  }

  /** Logs a completed download with its byte count and elapsed time. */
  private logDownloadComplete(
    entry: FeedEntry,
    startedAt: number,
    status: number,
    bytes: number,
  ): void {
    this._log.info("download", "downloaded", {
      itemId: entry.itemId,
      url: entry.s3PresignedUrl,
      status,
      bytes,
      elapsedMs: Date.now() - startedAt,
    });
  }

  /** Logs a download that threw, so the error is not swallowed silently. */
  private logDownloadError(entry: FeedEntry, error: unknown): void {
    this._log.error("download", "download threw", {
      itemId: entry.itemId,
      url: entry.s3PresignedUrl,
      error: describeError(error),
    });
  }

  /** Logs what happened to one vault path. */
  private logVault(outcome: string, path: string): void {
    this._log.info("vault", outcome, { path });
  }

  /** Reveals the log file in the OS file manager, so a human can hand it over. */
  async openLog(): Promise<void> {
    await this._log.flush();
    const absolutePath = logAbsolutePath(appVaultAdapter(this.app), LOG_PATH);
    if (absolutePath === undefined || !revealInOs(absolutePath)) {
      new Notice(`Petroglyph log: ${LOG_PATH}`);
    }
  }

  /** Copies the whole log to the clipboard, for pasting into a report. */
  async copyDiagnostics(): Promise<void> {
    await this._log.flush();
    try {
      await navigator.clipboard.writeText(await this._log.contents());
      new Notice("Petroglyph diagnostics copied");
    } catch {
      new Notice(`Could not copy diagnostics. The log is at ${LOG_PATH}.`);
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
      if (isRecord(raw["feedEtags"])) {
        saved.feedEtags = parseFeedEtags(raw["feedEtags"]);
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

      // Clean up cursors and versions whose profile IDs no longer exist
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

      if (this._data.feedEtags !== undefined) {
        const profileIds = new Set(profiles.map((p) => p.id));
        const cleanedEtags: { [profileId: string]: { [itemId: string]: string } } = {};
        for (const [key, val] of Object.entries(this._data.feedEtags)) {
          if (profileIds.has(key)) {
            cleanedEtags[key] = val;
          }
        }
        this._data = { ...this._data, feedEtags: cleanedEtags };
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
        this._log.error("auth", "onedrive connect failed", { status: response.status });
        new Notice("OneDrive connection failed");
        return;
      }
      this.setOneDriveConnected(true);
      this._data = { ...this._data, oneDriveStatus: "connected" };
      await this.savePluginData();
      this.refreshSettingsUi();
      this.startSyncPolling();
      new Notice("OneDrive connected");
    } catch (error) {
      this._log.error("auth", "onedrive connect failed", { error: describeError(error) });
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

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

/**
 * How long one manual-sync recheck waits before it reads the feed again. The
 * server answers the trigger at once and walks OneDrive in the background, so
 * the waiting is the plugin's job.
 */
export const SYNC_RECHECK_DELAY_MS = 2500;

/**
 * How many rechecks a manual sync makes after a first drain that staged nothing.
 * Together with `SYNC_RECHECK_DELAY_MS` this is about 5s of waiting; the target
 * wait is 10s, so raising one number must lower the other. Nothing enforces that
 * target: a slow drain pushes the whole wait past it.
 */
export const SYNC_RECHECK_ATTEMPTS = 2;

/** Shown when the trigger answers something the plugin cannot read. */
const TRIGGER_FAILED_NOTICE = "Sync request failed - checking for files";

/** Shown when the trigger was accepted but no file arrived before the cap. */
const SYNC_REQUESTED_NOTICE = "Sync requested - new files will arrive on the next poll";

/** The structured error envelope from `docs/api-conventions.md`. */
const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

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

/** The notice shown when a drain staged files and none of them failed. */
function syncCompleteNotice(synced: number): string {
  return `Sync complete: ${synced} ${synced === 1 ? "file" : "files"}`;
}

/**
 * Resolves `true` once `ms` has passed, or `false` as soon as `signal` aborts.
 * An aborted wait clears its timer, so nothing keeps running after the plugin
 * unloads.
 */
function waitForDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timeoutId = 0;
    const onAbort = (): void => {
      window.clearTimeout(timeoutId);
      resolve(false);
    };
    timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * True when `onunload()` aborted the manual sync that owns `controller`. A call
 * keeps the check fresh: reading the flag inline would let the compiler hold the
 * earlier answer across an await.
 */
function syncAborted(controller: AbortController): boolean {
  return controller.signal.aborted;
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
   * Manually sync the vault: POST /onedrive/sync-trigger, then drain GET /files
   * from the stored cursor and report the outcome. The trigger only enqueues one
   * OneDrive walk, so a document saved a moment ago is usually not in the feed
   * yet: when the first drain staged nothing, the feed is drained again a couple
   * of times before the user is told to wait for the next poll. A drain that
   * failed is reported as a failure and not retried here — its cursor did not
   * advance, so the next poll retries those files. A caller that arrives while
   * one of these syncs is still running is ignored.
   */
  async syncNow(): Promise<void> {
    if (this._data.jwt === undefined || !this._data.oneDriveConnected) {
      new Notice("Not connected. Cannot sync.");
      return;
    }
    // One manual sync at a time. The settings button has no debounce, so a
    // double click is the normal case, and the second click is ignored rather
    // than cancelling the sync the first click started. The slot is taken before
    // the first await, so two clicks in one tick cannot both pass the guard.
    if (this._syncAbort !== null) return;
    const controller = new AbortController();
    this._syncAbort = controller;

    const trigger = await this.triggerSyncWalk();
    if (syncAborted(controller)) {
      // `onunload()` ran while the trigger was in flight: drain nothing.
      this.endSync(controller);
      return;
    }
    if (trigger === "stop") {
      this.endSync(controller);
      await this._log.flush();
      return;
    }

    const profileId = this.resolveProfileId();
    let drain: FeedDrain | null = await this.drainFilesFeed(profileId);
    if (syncAborted(controller)) {
      this.endSync(controller);
      return;
    }
    if (drain.ok && drain.synced === 0) {
      drain = await this.recheckFilesFeed(profileId, drain, controller.signal);
    }
    this.endSync(controller);

    // An aborted sync writes nothing and reports nothing: no log flush, no
    // notice. Only the recheck wait resolves to null.
    if (drain === null) return;
    await this._log.flush();
    if (drain.ok) {
      new Notice(drain.synced === 0 ? SYNC_REQUESTED_NOTICE : syncCompleteNotice(drain.synced));
      return;
    }
    if (drain.reason === "files") {
      new Notice(fileFailureNotice(drain.synced, drain.failed));
      return;
    }
    new Notice(FEED_FAILURE_NOTICES[drain.reason]);
  }

  /** Releases the manual-sync slot, unless `onunload()` already cleared it. */
  private endSync(controller: AbortController): void {
    if (this._syncAbort === controller) this._syncAbort = null;
  }

  /**
   * POST /onedrive/sync-trigger asks the server to enqueue one OneDrive walk.
   * "stop" means a notice was shown and the feed must not be drained; the
   * trigger is only a bell, so every other answer falls through to the drain.
   */
  private async triggerSyncWalk(): Promise<"continue" | "stop"> {
    const jwt = this._data.jwt;
    if (jwt === undefined) return "stop";

    const url = `${this._data.apiBaseUrl}/onedrive/sync-trigger`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      });
    } catch (error) {
      this._log.warn("trigger", "request failed", { url, error: describeError(error) });
      new Notice(TRIGGER_FAILED_NOTICE);
      return "continue";
    }

    this._log.info("trigger", "requested", { url, status: response.status });
    if (response.status === 202) return "continue";
    if (response.status === 401) {
      // Keyed on the status: the shared JWT middleware still answers a flat
      // `{ "error": "UNAUTHORIZED" }` with no `code` to branch on.
      new Notice("Not connected. Cannot sync.");
      return "stop";
    }
    if (response.status === 409) {
      const refusal = await this.readTriggerRefusal(response);
      if (refusal !== null) {
        new Notice(refusal);
        return "stop";
      }
    }
    new Notice(TRIGGER_FAILED_NOTICE);
    return "continue";
  }

  /**
   * The server's own message for a 409 the user must act on, or null for any
   * other answer. Only `no_connection` and `reconnect_required` stop the sync;
   * a bare `conflict` still leaves the feed worth draining.
   */
  private async readTriggerRefusal(response: Response): Promise<string | null> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    const parsed = errorEnvelopeSchema.safeParse(body);
    if (!parsed.success) return null;
    const { code, message } = parsed.data.error;
    return code === "no_connection" || code === "reconnect_required" ? message : null;
  }

  /**
   * Re-drains the feed while a manual sync waits for the OneDrive walk to land.
   * Stops as soon as a re-drain stages a file or fails; null means the wait was
   * aborted by `onunload()`, so nothing more may be written or reported.
   */
  private async recheckFilesFeed(
    profileId: string,
    firstDrain: FeedDrain,
    signal: AbortSignal,
  ): Promise<FeedDrain | null> {
    let drain = firstDrain;
    for (let attempt = 0; attempt < SYNC_RECHECK_ATTEMPTS; attempt += 1) {
      if (!(await waitForDelay(SYNC_RECHECK_DELAY_MS, signal))) return null;
      drain = await this.drainFilesFeed(profileId);
      if (!drain.ok || drain.synced > 0) return drain;
    }
    return drain;
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
    let retriedRejectedCursor = false;
    let synced = 0;
    let failed = 0;

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
        await this.saveFeedCursor(profileId, undefined);
        cursor = undefined;
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
        if ((await this.writeFeedEntry(entry, destination.root)) === "failed") failed += 1;
        else synced += 1;
      }

      if (failed > 0) return { ok: false, reason: "files", synced, failed };

      await this.saveFeedCursor(profileId, feed.nextToken ?? undefined);
      if (feed.nextToken === null) return { ok: true, synced, failed };
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
   * does not churn the note's timestamps. An entry whose path would leave the
   * vault is rejected before anything is downloaded or written, and a failed
   * entry is reported, never thrown: one bad file must not abort the rest of
   * the page.
   */
  private async writeFeedEntry(entry: FeedEntry, root: string): Promise<"synced" | "failed"> {
    const mapping = vaultPathsFor(root, entry);
    if (!mapping.ok) {
      this.logVault("rejected: outside the vault", entry.relativePath);
      return "failed";
    }
    const paths = mapping.paths;
    try {
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
        return "synced";
      }

      await this.app.vault.adapter.writeBinary(paths.pdf, bytes as unknown as ArrayBuffer);
      this.logVault("wrote", paths.pdf);
      if (paths.markdown !== paths.pdf) {
        await this.app.vault.adapter.write(paths.markdown, companionNote(entry));
      }
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

  private readonly _log = new PluginLog({ sink: () => appLogSink(this.app) });
  private _data: PluginData = { ...DEFAULT_DATA };
  private _refreshTimeoutId: number | null = null;
  private _syncAbort: AbortController | null = null;
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
    this._syncAbort?.abort();
    this._syncAbort = null;
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

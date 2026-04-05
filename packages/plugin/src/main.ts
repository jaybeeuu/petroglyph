import { Notice, Plugin } from "obsidian";
import { PetroglyphSettingTab } from "./settings.js";
import type { AuthCallbackParams, PluginData } from "./types.js";
import { hasStringProp, isRecord } from "./validate.js";

const DEFAULT_DATA: PluginData = {
  apiBaseUrl: "http://localhost:3000",
};

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

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
  private _data: PluginData = { ...DEFAULT_DATA };
  private _refreshTimeoutId: number | null = null;

  get data(): Readonly<PluginData> {
    return this._data;
  }

  setCredentials(jwt: string, refreshToken: string, username: string): void {
    this._data = { ...this._data, jwt, refreshToken, username };
  }

  clearCredentials(): void {
    this._data = { apiBaseUrl: this._data.apiBaseUrl };
  }

  setApiBaseUrl(url: string): void {
    this._data = { ...this._data, apiBaseUrl: url };
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
      if (
        !isRecord(body) ||
        !hasStringProp(body, "jwt") ||
        !hasStringProp(body, "refreshToken")
      ) {
        return;
      }
      this.setCredentials(body.jwt, body.refreshToken, username);
      await this.savePluginData();
      this.scheduleRefresh(body.jwt);
    } catch {
      // Network errors are silently ignored; the next scheduled refresh will retry.
    }
  }

  override async onload(): Promise<void> {
    await this.loadPluginData();

    this.addSettingTab(new PetroglyphSettingTab(this.app, this));

    this.registerObsidianProtocolHandler(
      "petroglyph/auth/callback",
      async (params) => {
        const code = params["code"];
        const state = params["state"];
        if (typeof code !== "string" || typeof state !== "string") {
          new Notice("Login failed: missing code or state");
          return;
        }
        await this.handleAuthCallback({ code, state });
      },
    );

    if (this._data.jwt !== undefined) {
      this.scheduleRefresh(this._data.jwt);
    }
  }

  override onunload(): void {
    if (this._refreshTimeoutId !== null) {
      window.clearTimeout(this._refreshTimeoutId);
      this._refreshTimeoutId = null;
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
    }
    this._data = { ...DEFAULT_DATA, ...saved };
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
      new Notice(`Logged in as @${body.username}`);
    } catch {
      new Notice("Login failed");
    }
  }
}

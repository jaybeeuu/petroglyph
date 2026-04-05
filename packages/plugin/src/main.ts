import { Notice, Plugin } from "obsidian";
import { PetroglyphSettingTab } from "./settings.js";
import type { AuthCallbackParams, PluginData } from "./types.js";
import { hasStringProp, isRecord } from "./validate.js";

const DEFAULT_DATA: PluginData = {
  apiBaseUrl: "http://localhost:3000",
};

export class PetroglyphPlugin extends Plugin {
  private _data: PluginData = { ...DEFAULT_DATA };

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
      new Notice(`Logged in as @${body.username}`);
    } catch {
      new Notice("Login failed");
    }
  }
}

import { Notice, Plugin } from "obsidian";
import { PetroglyphSettingTab } from "./settings.js";
import type {
  AuthCallbackParams,
  AuthCallbackResponse,
  PluginData,
} from "./types.js";

const DEFAULT_DATA: PluginData = {
  apiBaseUrl: "http://localhost:3000",
};

export class PetroglyphPlugin extends Plugin {
  data: PluginData = { ...DEFAULT_DATA };

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
    const saved = (await this.loadData()) as Partial<PluginData> | null;
    this.data = { ...DEFAULT_DATA, ...saved };
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }

  async openAuthUrl(): Promise<void> {
    const response = await fetch(`${this.data.apiBaseUrl}/auth/url`);
    if (!response.ok) {
      new Notice("Failed to get auth URL");
      return;
    }
    const body = (await response.json()) as { url: string };
    window.open(body.url, "_blank");
  }

  async handleAuthCallback(params: AuthCallbackParams): Promise<void> {
    try {
      const response = await fetch(`${this.data.apiBaseUrl}/auth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        new Notice("Login failed");
        return;
      }

      const body = (await response.json()) as AuthCallbackResponse;
      this.data = {
        ...this.data,
        jwt: body.jwt,
        refreshToken: body.refreshToken,
        username: body.username,
      };
      await this.savePluginData();
      new Notice(`Logged in as @${body.username}`);
    } catch {
      new Notice("Login failed");
    }
  }
}

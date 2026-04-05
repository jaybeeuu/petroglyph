import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { PetroglyphPlugin } from "./main.js";

export class PetroglyphSettingTab extends PluginSettingTab {
  private readonly plugin: PetroglyphPlugin;

  constructor(app: App, plugin: PetroglyphPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Petroglyph" });

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("Base URL for the Petroglyph API server")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:3000")
          .setValue(this.plugin.data.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.setApiBaseUrl(value);
            await this.plugin.savePluginData();
          }),
      );

    const { username } = this.plugin.data;
    if (username !== undefined) {
      new Setting(containerEl)
        .setName("Account")
        .setDesc(`Logged in as @${username}`)
        .addButton((btn) =>
          btn.setButtonText("Disconnect").onClick(async () => {
            this.plugin.clearCredentials();
            await this.plugin.savePluginData();
            new Notice("Disconnected");
            this.display();
          }),
        );
    } else {
      new Setting(containerEl)
        .setName("GitHub account")
        .setDesc("Connect your GitHub account to use Petroglyph")
        .addButton((btn) =>
          btn.setButtonText("Connect").onClick(async () => {
            await this.plugin.openAuthUrl();
          }),
        );
    }
  }
}

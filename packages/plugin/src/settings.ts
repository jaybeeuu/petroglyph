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

    const { username, oneDriveStatus } = this.plugin.data;
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

      // Manual sync and reset buttons
      new Setting(containerEl)
        .setName("Sync Now")
        .setDesc("Manually trigger a sync now.")
        .addButton((btn) => btn.setButtonText("Sync Now").onClick(() => this.plugin.syncNow()));
      new Setting(containerEl)
        .setName("Reset Plugin State")
        .setDesc("Clear local sync token for this profile only.")
        .addButton((btn) =>
          btn.setButtonText("Reset Plugin State").onClick(() => this.plugin.resetPluginState()),
        );
      new Setting(containerEl)
        .setName("Reset Server State")
        .setDesc("Reset server sync state only.")
        .addButton((btn) =>
          btn.setButtonText("Reset Server State").onClick(() => this.plugin.resetServerState()),
        );
      new Setting(containerEl)
        .setName("Full Reset")
        .setDesc("Reset both server and local sync state.")
        .addButton((btn) => btn.setButtonText("Full Reset").onClick(() => this.plugin.fullReset()));
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

    // OneDrive reconnect_required banner
    if (oneDriveStatus === "reconnect_required") {
      const banner = containerEl.createEl("div", { cls: "petroglyph-onedrive-banner" });
      banner.textContent = "OneDrive connection lost — action required";
      const btn = banner.createEl("button", { text: "Reconnect OneDrive" });
      btn.onclick = async () => {
        await this.plugin.openOneDriveAuthUrl();
      };
    }

    const { oneDriveConnected } = this.plugin.data;
    if (oneDriveConnected) {
      new Setting(containerEl)
        .setName("OneDrive")
        .setDesc("OneDrive connected ✓")
        .addButton((btn) =>
          btn.setButtonText("Disconnect").onClick(() => {
            // Placeholder — disconnect not yet implemented
          }),
        );
    } else if (oneDriveStatus !== "reconnect_required") {
      new Setting(containerEl)
        .setName("OneDrive")
        .setDesc("Connect your OneDrive account")
        .addButton((btn) =>
          btn.setButtonText("Connect OneDrive").onClick(async () => {
            await this.plugin.openOneDriveAuthUrl();
          }),
        );
    }

    // Profiles section
    containerEl.createEl("h3", { text: "Profiles" });
    const profiles = this.plugin.data.profiles ?? [];
    if (profiles.length === 0) {
      containerEl.createEl("p", { text: "No profiles found." });
    } else {
      for (const profile of profiles) {
        const isActive = profile.id === this.plugin.data.activeProfileId;
        new Setting(containerEl)
          .setName(profile.name + (isActive ? " ✓ (active)" : ""))
          .setDesc(`Source: ${profile.sourceFolderPath} → Destination: ${profile.destinationVaultPath}`)
          .addButton((btn) =>
            btn.setButtonText("Set active").onClick(async () => {
              await this.plugin.setActiveProfile(profile.id);
              this.display();
            }),
          );
      }
    }
  }
}

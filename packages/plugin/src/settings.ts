import type { App } from "obsidian";
import { Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type { PetroglyphPlugin } from "./main.js";

class ProfileModal extends Modal {
  private readonly onSubmit: (
    name: string,
    sourceFolderPath: string,
    destinationVaultPath: string,
  ) => void;
  private readonly initialValues:
    | {
        name: string;
        sourceFolderPath: string;
        destinationVaultPath: string;
      }
    | undefined;

  constructor(
    app: App,
    onSubmit: (name: string, sourceFolderPath: string, destinationVaultPath: string) => void,
    initialValues?: { name: string; sourceFolderPath: string; destinationVaultPath: string },
  ) {
    super(app);
    this.onSubmit = onSubmit;
    this.initialValues = initialValues;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", {
      text: this.initialValues !== undefined ? "Edit Profile" : "New Profile",
    });

    let name = this.initialValues?.name ?? "";
    let sourceFolderPath = this.initialValues?.sourceFolderPath ?? "";
    let destinationVaultPath = this.initialValues?.destinationVaultPath ?? "";

    new Setting(contentEl).setName("Name").addText((text) =>
      text.setValue(name).onChange((value) => {
        name = value;
      }),
    );

    new Setting(contentEl).setName("Source folder path").addText((text) =>
      text.setValue(sourceFolderPath).onChange((value) => {
        sourceFolderPath = value;
      }),
    );

    new Setting(contentEl).setName("Destination vault path").addText((text) =>
      text.setValue(destinationVaultPath).onChange((value) => {
        destinationVaultPath = value;
      }),
    );

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Save")
          .setCta()
          .onClick(() => {
            this.close();
            this.onSubmit(name, sourceFolderPath, destinationVaultPath);
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

class DeleteConfirmModal extends Modal {
  private readonly onConfirm: () => void;

  constructor(app: App, onConfirm: () => void) {
    super(app);
    this.onConfirm = onConfirm;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Delete Profile" });
    contentEl.createEl("p", {
      text: "Are you sure you want to delete this profile? This cannot be undone.",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Delete")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

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
    new Setting(containerEl)
      .setName("Profiles")
      .setHeading()
      .addButton((btn) =>
        btn.setButtonText("New Profile").onClick(() => {
          new ProfileModal(this.app, async (name, sourceFolderPath, destinationVaultPath) => {
            await this.plugin.createProfile({ name, sourceFolderPath, destinationVaultPath });
            this.display();
          }).open();
        }),
      );
    const profiles = this.plugin.data.profiles ?? [];
    if (profiles.length === 0) {
      containerEl.createEl("p", { text: "No profiles found." });
    } else {
      for (const profile of profiles) {
        const isActive = profile.id === this.plugin.data.activeProfileId;
        new Setting(containerEl)
          .setName(profile.name + (isActive ? " ✓ (active)" : ""))
          .setDesc(
            `Source: ${profile.sourceFolderPath} → Destination: ${profile.destinationVaultPath}`,
          )
          .addButton((btn) =>
            btn.setButtonText("Set active").onClick(async () => {
              await this.plugin.setActiveProfile(profile.id);
              this.display();
            }),
          )
          .addButton((btn) =>
            btn.setButtonText("Edit").onClick(() => {
              new ProfileModal(
                this.app,
                async (name, sourceFolderPath, destinationVaultPath) => {
                  await this.plugin.editProfile(profile.id, {
                    name,
                    sourceFolderPath,
                    destinationVaultPath,
                  });
                  this.display();
                },
                {
                  name: profile.name,
                  sourceFolderPath: profile.sourceFolderPath,
                  destinationVaultPath: profile.destinationVaultPath,
                },
              ).open();
            }),
          )
          .addButton((btn) =>
            btn.setButtonText("Delete").onClick(() => {
              new DeleteConfirmModal(this.app, async () => {
                await this.plugin.deleteProfile(profile.id);
                this.display();
              }).open();
            }),
          );
      }
    }
  }
}

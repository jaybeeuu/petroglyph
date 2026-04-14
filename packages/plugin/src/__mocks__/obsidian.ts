// Minimal stub so Vitest can resolve the obsidian module.
// Tests that import obsidian should use vi.mock('obsidian', ...) to replace it.
/* eslint-disable @typescript-eslint/no-extraneous-class, @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars */
export class App {}
export class Plugin {
  constructor(_app: unknown, _manifest: unknown) {}
  loadData(): Promise<unknown> {
    return Promise.resolve(null);
  }
  saveData(_data: unknown): Promise<void> {
    return Promise.resolve();
  }
  addSettingTab(_tab: unknown): void {}
  registerObsidianProtocolHandler(_id: string, _handler: unknown): void {}
}
export class PluginSettingTab {
  constructor(_app: unknown, _plugin: unknown) {}
}
export class Modal {
  app: unknown;
  contentEl: { empty(): void; createEl(_tag: string, _opts?: unknown): unknown } = {
    empty() {},
    createEl() {
      return {};
    },
  };
  constructor(_app: unknown) {}
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}
export class Notice {
  constructor(_message: string) {}
}
export class Setting {
  constructor(_containerEl: unknown) {}
}
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
}

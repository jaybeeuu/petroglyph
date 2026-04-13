// Minimal stub so Vitest can resolve the obsidian module.
// Tests that import obsidian should use vi.mock('obsidian', ...) to replace it.
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

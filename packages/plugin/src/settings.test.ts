import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";

const buttonHandlers = new Map<string, () => Promise<void> | void>();

vi.mock("obsidian", () => ({
  Notice: Notice,

  Plugin: class {
    constructor(_app: unknown, _manifest: unknown) {}
  },
  PluginSettingTab: class {
    containerEl = {
      empty: vi.fn(),
      createEl: vi.fn(),
    };
  },
  App: class {},
  Setting: class {
    setName(_: string) {
      return this;
    }
    setDesc(_: string) {
      return this;
    }
    addButton(fn: (btn: ButtonStub) => void) {
      let buttonText = "";
      const btn: ButtonStub = {
        setButtonText(text: string) {
          buttonText = text;
          return btn;
        },
        onClick(cb: () => void) {
          buttonHandlers.set(buttonText, cb);
          return btn;
        },
      };
      fn(btn);
      return this;
    }
    addText(fn: (text: TextStub) => void) {
      const text: TextStub = {
        setPlaceholder(_: string) {
          return text;
        },
        setValue(_: string) {
          return text;
        },
        onChange(_: (v: string) => Promise<void> | void) {
          return text;
        },
      };
      fn(text);
      return this;
    }
  },
}));

interface ButtonStub {
  setButtonText(text: string): ButtonStub;
  onClick(cb: () => void): ButtonStub;
}

interface TextStub {
  setPlaceholder(ph: string): TextStub;
  setValue(val: string): TextStub;
  onChange(cb: (v: string) => Promise<void> | void): TextStub;
}

const Notice = vi.fn();

async function makePlugin(options: { username?: string; oneDriveConnected?: boolean } = {}) {
  const { PetroglyphPlugin } = await import("./main.js");

  const plugin = new PetroglyphPlugin({} as App, {} as PluginManifest);
  plugin.loadData = vi.fn(async () => null);
  plugin.saveData = vi.fn();
  plugin.registerObsidianProtocolHandler = vi.fn();
  plugin.addSettingTab = vi.fn();
  plugin.app = {};

  await plugin.loadPluginData();

  if (options.username !== undefined) {
    plugin.setCredentials("jwt-token", "refresh-token", options.username);
  }

  if (options.oneDriveConnected !== undefined) {
    plugin.setOneDriveConnected(options.oneDriveConnected);
  }

  return plugin;
}

describe("PetroglyphSettingTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buttonHandlers.clear();
  });

  it("shows Connect button when logged out", async () => {
    const plugin = await makePlugin();
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    expect(buttonHandlers.has("Connect")).toBe(true);
    expect(buttonHandlers.has("Disconnect")).toBe(false);
  });

  it("shows Disconnect button when logged in", async () => {
    const plugin = await makePlugin({ username: "alice" });
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    expect(buttonHandlers.has("Disconnect")).toBe(true);
    expect(buttonHandlers.has("Connect")).toBe(false);
  });

  it("Connect button click calls openAuthUrl", async () => {
    const plugin = await makePlugin();
    plugin.openAuthUrl = vi.fn().mockResolvedValue(undefined);
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    await buttonHandlers.get("Connect")?.();
    expect(plugin.openAuthUrl).toHaveBeenCalled();
  });

  it("Disconnect button clears credentials, saves data, and shows notice", async () => {
    const plugin = await makePlugin({ username: "alice" });
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    await buttonHandlers.get("Disconnect")?.();
    expect(plugin.data.username).toBeUndefined();
    expect(plugin.data.jwt).toBeUndefined();
    expect(plugin.saveData).toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith("Disconnected");
  });
});

describe("PetroglyphSettingTab OneDrive section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buttonHandlers.clear();
  });

  it("shows Connect OneDrive button when not connected", async () => {
    const plugin = await makePlugin();
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    expect(buttonHandlers.has("Connect OneDrive")).toBe(true);
    expect(buttonHandlers.has("Disconnect")).toBe(false);
  });

  it("shows connected status and Disconnect button when connected", async () => {
    const plugin = await makePlugin({ oneDriveConnected: true });
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    expect(buttonHandlers.has("Connect OneDrive")).toBe(false);
    expect(buttonHandlers.has("Disconnect")).toBe(true);
  });

  it("Connect OneDrive button click calls openOneDriveAuthUrl", async () => {
    const plugin = await makePlugin();
    plugin.openOneDriveAuthUrl = vi.fn().mockResolvedValue(undefined);
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    await buttonHandlers.get("Connect OneDrive")?.();
    expect(plugin.openOneDriveAuthUrl).toHaveBeenCalled();
  });
});

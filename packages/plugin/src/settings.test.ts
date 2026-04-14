import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import type { PetroglyphPlugin } from "./main.js";

const buttonHandlers = new Map<string, () => Promise<void> | void>();

/* eslint-disable @typescript-eslint/no-extraneous-class, @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-function-return-type */
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
  Modal: class {
    contentEl = { empty: vi.fn(), createEl: vi.fn(() => ({})) };
    open() {}
    close() {}
  },
  Setting: class {
    setName(_: string) {
      return this;
    }
    setHeading() {
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
/* eslint-enable @typescript-eslint/no-extraneous-class, @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-function-return-type */

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

async function makePlugin(
  options: { username?: string; oneDriveConnected?: boolean } = {},
): Promise<PetroglyphPlugin> {
  const { PetroglyphPlugin: PluginClass } = await import("./main.js");

  const plugin = new PluginClass({} as App, {} as PluginManifest);
  plugin.loadData = vi.fn(() => Promise.resolve(null));
  plugin.saveData = vi.fn();
  plugin.registerObsidianProtocolHandler = vi.fn();
  plugin.addSettingTab = vi.fn();
  plugin.app = {} as App;

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
    // eslint-disable-next-line @typescript-eslint/unbound-method
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
    // eslint-disable-next-line @typescript-eslint/unbound-method
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
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.openOneDriveAuthUrl).toHaveBeenCalled();
  });
});

describe("PetroglyphSettingTab Profiles section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buttonHandlers.clear();
  });

  it("shows 'Set active' buttons for each profile", async () => {
    const plugin = await makePlugin({ username: "alice" });
    // @ts-expect-error — testing internal data
    plugin._data = {
      ...plugin.data,
      profiles: [
        { id: "p1", name: "Profile 1", sourceFolderPath: "/src", destinationVaultPath: "/dst" },
        { id: "p2", name: "Profile 2", sourceFolderPath: "/src2", destinationVaultPath: "/dst2" },
      ],
    };
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    expect(buttonHandlers.has("Set active")).toBe(true);
  });

  it("'Set active' button calls setActiveProfile with profile id", async () => {
    const plugin = await makePlugin({ username: "alice" });
    // @ts-expect-error — testing internal data
    plugin._data = {
      ...plugin.data,
      profiles: [
        { id: "p1", name: "Profile 1", sourceFolderPath: "/src", destinationVaultPath: "/dst" },
      ],
    };
    plugin.setActiveProfile = vi.fn().mockResolvedValue(undefined);
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    await buttonHandlers.get("Set active")?.();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.setActiveProfile).toHaveBeenCalledWith("p1");
  });
});

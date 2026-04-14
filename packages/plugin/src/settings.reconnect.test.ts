import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import type { PetroglyphPlugin } from "./main.js";

const buttonHandlers = new Map<string, () => Promise<void> | void>();

/* eslint-disable @typescript-eslint/no-extraneous-class, @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-function-return-type */
vi.mock("obsidian", () => ({
  Notice: vi.fn(),
  Plugin: class {
    constructor(_app: unknown, _manifest: unknown) {}
  },
  PluginSettingTab: class {
    containerEl = {
      empty: vi.fn(),
      createEl: vi.fn((tag, _opts) => {
        if (tag === "div") {
          // Banner div: needs textContent and createEl for button
          const button: { onclick: undefined | (() => Promise<void> | void) } = {
            onclick: undefined,
          };
          const banner = {
            textContent: "",
            createEl: vi.fn((btnTag, _btnOpts) => {
              if (btnTag === "button") {
                // Register the handler for test
                button.onclick = undefined;
                buttonHandlers.set("Reconnect OneDrive", async () => {
                  if (typeof button.onclick === "function") {
                    await button.onclick();
                  }
                });
                return button;
              }
              return {};
            }),
          };
          return banner;
        }
        if (tag === "button") {
          return { onclick: undefined };
        }
        return {};
      }),
    };
  },
  App: class {},
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
  Modal: class {
    contentEl = { empty: vi.fn(), createEl: vi.fn(() => ({})) };
    open() {}
    close() {}
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

vi.fn(); // Notice mock — imported by obsidian vi.mock factory above

async function makePlugin(
  options: { username?: string; oneDriveConnected?: boolean; oneDriveStatus?: string } = {},
): Promise<PetroglyphPlugin> {
  const { PetroglyphPlugin } = await import("./main.js");

  const plugin = new PetroglyphPlugin({} as App, {} as PluginManifest);
  const initialData: { [key: string]: unknown } = {};
  if (options.oneDriveStatus !== undefined) {
    initialData["oneDriveStatus"] = options.oneDriveStatus;
  }
  plugin.loadData = vi.fn(() =>
    Promise.resolve(Object.keys(initialData).length > 0 ? initialData : null),
  );
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

describe("PetroglyphSettingTab OneDrive reconnect banner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buttonHandlers.clear();
  });

  it("shows reconnect banner and button when oneDriveStatus is reconnect_required", async () => {
    const plugin = await makePlugin({ oneDriveStatus: "reconnect_required" });
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    expect(buttonHandlers.has("Reconnect OneDrive")).toBe(true);
  });

  it("Reconnect OneDrive button click calls openOneDriveAuthUrl", async () => {
    const plugin = await makePlugin({ oneDriveStatus: "reconnect_required" });
    plugin.openOneDriveAuthUrl = vi.fn().mockResolvedValue(undefined);
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    await buttonHandlers.get("Reconnect OneDrive")?.();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.openOneDriveAuthUrl).toHaveBeenCalled();
  });

  it("does not show reconnect banner when oneDriveStatus is connected", async () => {
    const plugin = await makePlugin({ oneDriveStatus: "connected" });
    const { PetroglyphSettingTab } = await import("./settings.js");
    const tab = new PetroglyphSettingTab({} as App, plugin);
    tab.display();
    expect(buttonHandlers.has("Reconnect OneDrive")).toBe(false);
  });
});

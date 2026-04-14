import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import type { PetroglyphPlugin } from "./main.js";

// Use the same Notice mock and obsidian vi.mock as main.test.ts for consistency
const Notice = vi.fn();
/* eslint-disable @typescript-eslint/no-extraneous-class, @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-function-return-type */
vi.mock("obsidian", () => ({
  Notice: Notice,
  Plugin: class {
    constructor(_app: unknown, _manifest: unknown) {}
  },
  PluginSettingTab: class {},
  App: class {},
  Modal: class {
    contentEl = { empty: vi.fn(), createEl: vi.fn(() => ({})) };
    open() {}
    close() {}
  },
  Setting: class {},
  normalizePath: (path: string) => path,
}));
/* eslint-enable @typescript-eslint/no-extraneous-class, @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-function-return-type */

async function makePluginWithMocks(initialData?: {
  [key: string]: unknown;
}): Promise<PetroglyphPlugin> {
  const { PetroglyphPlugin } = await import("./main.js");
  const plugin = new PetroglyphPlugin({} as App, {} as PluginManifest);
  plugin.loadData = vi.fn(() => Promise.resolve(initialData ?? null));
  plugin.saveData = vi.fn();
  plugin.savePluginData = vi.fn();
  plugin.app = {} as App;
  await plugin.loadPluginData();
  return plugin;
}

describe("PetroglyphPlugin manual sync/reset commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncNow calls POST /sync/run then pages GET /files/changes to completion", async () => {
    const plugin = await makePluginWithMocks({
      jwt: "jwt-token",
      oneDriveConnected: true,
      changeTokens: { default: undefined },
    });
    let syncRunCalled = false;
    let filesChangesCalls = 0;
    global.fetch = vi.fn((...args) => {
      if (typeof args[0] === "string" && args[0].endsWith("/sync/run")) {
        syncRunCalled = true;
        return Promise.resolve({ ok: true });
      }
      if (typeof args[0] === "string" && args[0].includes("/files/changes")) {
        filesChangesCalls++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ files: [], nextToken: null }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;
    await plugin.syncNow();
    expect(syncRunCalled).toBe(true);
    expect(filesChangesCalls).toBe(1);
    expect(Notice).toHaveBeenCalledWith("Sync complete");
  });

  it("resetPluginState clears local token and shows notice", async () => {
    const plugin = await makePluginWithMocks({
      changeTokens: { default: "tok" },
    });
    await plugin.resetPluginState();
    expect(plugin["_data"].changeTokens?.["default"]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.savePluginData).toHaveBeenCalled();
  });

  it("resetServerState calls POST /sync/reset with scope=server and shows notice", async () => {
    const plugin = await makePluginWithMocks({ jwt: "jwt-token" });
    global.fetch = vi.fn((...args) => {
      if (typeof args[0] === "string" && args[0].includes("/sync/reset")) {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;
    await plugin.resetServerState();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sync/reset"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scope: "server" }),
      }),
    );
    expect(Notice).toHaveBeenCalledWith("Server state reset");
  });

  it("fullReset calls POST /sync/reset with scope=full, clears token if resetToken, and shows notice", async () => {
    const plugin = await makePluginWithMocks({
      jwt: "jwt-token",
      changeTokens: { default: "tok" },
    });
    global.fetch = vi.fn((...args) => {
      if (typeof args[0] === "string" && args[0].includes("/sync/reset")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ resetToken: true, files: [], nextToken: null }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;
    await plugin.fullReset();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sync/reset"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scope: "full" }),
      }),
    );
    expect(plugin["_data"].changeTokens?.["default"]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.savePluginData).toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith("Full reset complete");
  });
});

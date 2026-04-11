import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";

// Use the same Notice mock and obsidian vi.mock as main.test.ts for consistency
const Notice = vi.fn();
vi.mock("obsidian", () => ({
  Notice: Notice,
  Plugin: class {
    constructor(_app: unknown, _manifest: unknown) {}
  },
  PluginSettingTab: class {},
  App: class {},
  Setting: class {},
  normalizePath: (path: string) => path,
}));

async function makePluginWithMocks(initialData?: Record<string, unknown>) {
  const { PetroglyphPlugin } = await import("./main.js");
  const plugin = new PetroglyphPlugin({} as App, {} as PluginManifest);
  plugin.loadData = vi.fn(async () => initialData ?? null);
  plugin.saveData = vi.fn();
  plugin.savePluginData = vi.fn();
  // @ts-expect-error — minimal stub
  plugin.app = {};
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
          json: async () => ({ files: [], nextToken: null }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
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
    expect(plugin._data.changeTokens?.default).toBeUndefined();
    expect(plugin.savePluginData).toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith(
      "Plugin state reset: local sync token cleared"
    );
  });

  it("resetServerState calls POST /sync/reset with scope=server and shows notice", async () => {
    const plugin = await makePluginWithMocks({ jwt: "jwt-token" });
    global.fetch = vi.fn((...args) => {
      if (typeof args[0] === "string" && args[0].includes("/sync/reset")) {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    await plugin.resetServerState();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sync/reset"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scope: "server" }),
      })
    );
    expect(Notice).toHaveBeenCalledWith("Server state reset");
  });

  it("fullReset calls POST /sync/reset with scope=full, clears token if resetToken, and shows notice", async () => {
    const plugin = await makePluginWithMocks({ jwt: "jwt-token", changeTokens: { default: "tok" } });
    global.fetch = vi.fn((...args) => {
      if (typeof args[0] === "string" && args[0].includes("/sync/reset")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ resetToken: true, files: [], nextToken: null }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    await plugin.fullReset();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sync/reset"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scope: "full" }),
      })
    );
    expect(plugin._data.changeTokens?.default).toBeUndefined();
    expect(plugin.savePluginData).toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith("Full reset complete");
  });
});

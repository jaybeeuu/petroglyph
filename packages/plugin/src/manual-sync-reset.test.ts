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

  it("syncNow asks the server to walk OneDrive, then drains GET /files", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    try {
      const plugin = await makePluginWithMocks({
        jwt: "jwt-token",
        oneDriveConnected: true,
      });
      const requested: string[] = [];
      global.fetch = vi.fn((url: string) => {
        requested.push(url);
        if (url.endsWith("/onedrive/sync-trigger")) {
          return Promise.resolve({ ok: true, status: 202 });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ files: [], nextToken: null }),
        });
      }) as unknown as typeof fetch;

      const sync = plugin.syncNow();
      await vi.advanceTimersByTimeAsync(10_000);
      await sync;

      expect(requested[0]).toBe("https://api.petroglyph.page/onedrive/sync-trigger");
      expect(requested.filter((url) => url.includes("/files"))).toHaveLength(3);
      expect(Notice).toHaveBeenCalledWith(
        "Sync requested - new files will arrive on the next poll",
      );
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("resetPluginState clears local token and shows notice", async () => {
    const plugin = await makePluginWithMocks({
      feedCursors: { default: "tok" },
    });
    await plugin.resetPluginState();
    expect(plugin["_data"].feedCursors?.["default"]).toBeUndefined();
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
      feedCursors: { default: "tok" },
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
    expect(plugin["_data"].feedCursors?.["default"]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.savePluginData).toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith("Full reset complete");
  });
});

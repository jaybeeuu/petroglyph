import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";

vi.mock("obsidian", () => ({
  Notice: vi.fn(),
  Plugin: class {
    constructor(_app: unknown, _manifest: unknown) {}
  },
  PluginSettingTab: class {},
  App: class {},
  Setting: class {},
}));

const { Notice } = await import("obsidian");

async function makePlugin() {
  const { PetroglyphPlugin } = await import("./main.js");

  const savedData: Record<string, unknown> = {};
  const plugin = new PetroglyphPlugin(
    {} as App,
    {} as PluginManifest,
  );

  plugin.loadData = vi.fn(async () => savedData["data"] ?? null);
  plugin.saveData = vi.fn(async (data: unknown) => {
    savedData["data"] = data;
  });
  plugin.registerObsidianProtocolHandler = vi.fn();
  plugin.addSettingTab = vi.fn();
  // @ts-expect-error — minimal stub
  plugin.app = {};

  await plugin.loadPluginData();

  return { plugin, savedData };
}

describe("handleAuthCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("saves jwt, refreshToken and username on success and shows notice", async () => {
    const { plugin } = await makePlugin();
    plugin.data.apiBaseUrl = "http://localhost:3000";

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jwt: "jwt-token",
        refreshToken: "refresh-token",
        username: "alice",
      }),
    });

    await plugin.handleAuthCallback({ code: "abc", state: "xyz" });

    expect(plugin.data.jwt).toBe("jwt-token");
    expect(plugin.data.refreshToken).toBe("refresh-token");
    expect(plugin.data.username).toBe("alice");
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice" }),
    );
    expect(Notice).toHaveBeenCalledWith("Logged in as @alice");
  });

  it("shows 'Login failed' notice when response is not ok", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    await plugin.handleAuthCallback({ code: "bad", state: "bad" });

    expect(plugin.data.jwt).toBeUndefined();
    expect(Notice).toHaveBeenCalledWith("Login failed");
  });

  it("shows 'Login failed' notice on fetch error", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await plugin.handleAuthCallback({ code: "err", state: "err" });

    expect(Notice).toHaveBeenCalledWith("Login failed");
  });
});

describe("loadPluginData / savePluginData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges saved data with defaults", async () => {
    const { PetroglyphPlugin } = await import("./main.js");
    const plugin = new PetroglyphPlugin(
      {} as App,
      {} as PluginManifest,
    );

    plugin.loadData = vi.fn(async () => ({
      apiBaseUrl: "https://custom.api",
      username: "bob",
    }));
    plugin.saveData = vi.fn();
    plugin.registerObsidianProtocolHandler = vi.fn();
    plugin.addSettingTab = vi.fn();
    // @ts-expect-error — minimal stub
    plugin.app = {};

    await plugin.loadPluginData();

    expect(plugin.data.apiBaseUrl).toBe("https://custom.api");
    expect(plugin.data.username).toBe("bob");
  });

  it("uses defaults when no saved data exists", async () => {
    const { plugin } = await makePlugin();
    expect(plugin.data.apiBaseUrl).toBe("http://localhost:3000");
    expect(plugin.data.jwt).toBeUndefined();
  });

  it("persists data via saveData", async () => {
    const { plugin } = await makePlugin();
    plugin.data.username = "carol";
    await plugin.savePluginData();
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({ username: "carol" }),
    );
  });
});

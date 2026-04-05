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

async function makePlugin(initialData?: Record<string, unknown>) {
  const { PetroglyphPlugin } = await import("./main.js");

  const savedData: Record<string, unknown> = {};
  if (initialData !== undefined) {
    savedData["data"] = initialData;
  }

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

  it("shows 'Login failed' notice when response body is missing fields", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jwt: "token" }),
    });

    await plugin.handleAuthCallback({ code: "abc", state: "xyz" });

    expect(plugin.data.jwt).toBeUndefined();
    expect(Notice).toHaveBeenCalledWith("Login failed");
  });
});

describe("openAuthUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens the auth URL in a new tab on success", async () => {
    const { plugin } = await makePlugin();
    vi.stubGlobal("window", { open: vi.fn() });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://github.com/login/oauth/authorize?..." }),
    });

    await plugin.openAuthUrl();

    expect(window.open).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize?...",
      "_blank",
    );
  });

  it("shows notice when response is not ok", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    await plugin.openAuthUrl();

    expect(Notice).toHaveBeenCalledWith("Failed to get auth URL");
  });

  it("shows notice when response body has no url field", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ notUrl: 42 }),
    });

    await plugin.openAuthUrl();

    expect(Notice).toHaveBeenCalledWith("Failed to get auth URL");
  });

  it("shows notice on fetch error", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await plugin.openAuthUrl();

    expect(Notice).toHaveBeenCalledWith("Failed to get auth URL");
  });
});

describe("loadPluginData / savePluginData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges saved data with defaults", async () => {
    const { plugin } = await makePlugin({
      apiBaseUrl: "https://custom.api",
      username: "bob",
    });

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
    plugin.setCredentials("jwt-token", "refresh-token", "carol");
    await plugin.savePluginData();
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({ username: "carol" }),
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";

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

const Notice = vi.fn();

function makeTestJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test", exp })).toString("base64url");
  return `${header}.${payload}.fakesignature`;
}

function makeTestJwtWithoutExp(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test" })).toString("base64url");
  return `${header}.${payload}.fakesignature`;
}

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
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("starts status polling after successful auth callback", async () => {
    const { plugin } = await makePlugin();

    const pollStatusSpy = vi.spyOn(plugin, "pollStatus").mockResolvedValue(undefined);
    vi.spyOn(plugin, "scheduleRefresh").mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jwt: "jwt-token",
        refreshToken: "refresh-token",
        username: "alice",
      }),
    });

    await plugin.handleAuthCallback({ code: "abc", state: "xyz" });

    expect(pollStatusSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(pollStatusSpy).toHaveBeenCalledOnce();
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

describe("clearCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes jwt, refreshToken, and username", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      refreshToken: "refresh-token",
      username: "alice",
    });

    plugin.clearCredentials();

    expect(plugin.data.jwt).toBeUndefined();
    expect(plugin.data.refreshToken).toBeUndefined();
    expect(plugin.data.username).toBeUndefined();
  });

  it("resets oneDriveConnected to false", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      refreshToken: "refresh-token",
      username: "alice",
      oneDriveConnected: true,
    });

    plugin.clearCredentials();

    expect(plugin.data.oneDriveConnected).toBe(false);
  });

  it("preserves apiBaseUrl", async () => {
    const { plugin } = await makePlugin({
      apiBaseUrl: "https://custom.api",
      jwt: "jwt-token",
      refreshToken: "refresh-token",
      username: "alice",
    });

    plugin.clearCredentials();

    expect(plugin.data.apiBaseUrl).toBe("https://custom.api");
  });

  it("clears the status poll interval", async () => {
    const clearIntervalMock = vi.fn();
    vi.stubGlobal("window", {
      ...makeWindowStub(),
      setInterval: vi.fn().mockReturnValue(77),
      clearInterval: clearIntervalMock,
    });

    const { plugin } = await makePlugin();
    plugin.startStatusPolling();

    plugin.clearCredentials();

    expect(clearIntervalMock).toHaveBeenCalledWith(77);
  });
});

function makeWindowStub() {
  return {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
}

describe("scheduleRefresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("schedules performRefresh 5 minutes before JWT expiry", async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    // expires 30 min from now; delay should be 25 min
    const expiresInSeconds = now / 1000 + 30 * 60;
    const jwt = makeTestJwt(expiresInSeconds);

    const { plugin } = await makePlugin();
    const performRefreshSpy = vi.spyOn(plugin, "performRefresh").mockResolvedValue(undefined);

    plugin.scheduleRefresh(jwt);

    expect(performRefreshSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(25 * 60 * 1000 - 1);
    expect(performRefreshSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(performRefreshSpy).toHaveBeenCalledOnce();
  });

  it("does not schedule when JWT payload has no exp field", async () => {
    const { plugin } = await makePlugin();
    const performRefreshSpy = vi.spyOn(plugin, "performRefresh").mockResolvedValue(undefined);

    plugin.scheduleRefresh(makeTestJwtWithoutExp());

    vi.advanceTimersByTime(999_999_999);
    expect(performRefreshSpy).not.toHaveBeenCalled();
  });
});

describe("performRefresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("calls POST /auth/refresh with refreshToken and updates credentials", async () => {
    const newJwt = makeTestJwt(Math.floor(Date.now() / 1000) + 3600);
    const { plugin } = await makePlugin({
      jwt: "old-jwt",
      refreshToken: "old-refresh",
      username: "alice",
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jwt: newJwt, refreshToken: "new-refresh" }),
    });

    await plugin.performRefresh();

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/auth/refresh",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ refreshToken: "old-refresh" }),
      }),
    );
    expect(plugin.data.jwt).toBe(newJwt);
    expect(plugin.data.refreshToken).toBe("new-refresh");
    expect(plugin.data.username).toBe("alice");
  });

  it("reschedules refresh after successful token refresh", async () => {
    const newJwt = makeTestJwt(Math.floor(Date.now() / 1000) + 3600);
    const { plugin } = await makePlugin({
      jwt: "old-jwt",
      refreshToken: "old-refresh",
      username: "alice",
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jwt: newJwt, refreshToken: "new-refresh" }),
    });

    const scheduleRefreshSpy = vi.spyOn(plugin, "scheduleRefresh").mockImplementation(() => {});
    await plugin.performRefresh();

    expect(scheduleRefreshSpy).toHaveBeenCalledWith(newJwt);
  });

  it("does nothing when no refreshToken is stored", async () => {
    const { plugin } = await makePlugin();
    global.fetch = vi.fn();

    await plugin.performRefresh();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not update credentials when response is not ok", async () => {
    const { plugin } = await makePlugin({
      jwt: "old-jwt",
      refreshToken: "old-refresh",
      username: "alice",
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    await plugin.performRefresh();

    expect(plugin.data.jwt).toBe("old-jwt");
  });
});

describe("onload with JWT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("schedules refresh when JWT is present in saved data", async () => {
    const jwt = makeTestJwt(Math.floor(Date.now() / 1000) + 3600);
    const { PetroglyphPlugin } = await import("./main.js");
    const plugin = new PetroglyphPlugin({} as App, {} as PluginManifest);
    plugin.loadData = vi.fn(async () => ({ jwt, refreshToken: "r", username: "alice", apiBaseUrl: "http://localhost:3000" }));
    plugin.saveData = vi.fn();
    plugin.registerObsidianProtocolHandler = vi.fn();
    plugin.addSettingTab = vi.fn();
    // @ts-expect-error — minimal stub
    plugin.app = {};

    const scheduleRefreshSpy = vi.spyOn(plugin, "scheduleRefresh").mockImplementation(() => {});

    await plugin.onload();

    expect(scheduleRefreshSpy).toHaveBeenCalledWith(jwt);
  });

  it("does not schedule refresh when no JWT in saved data", async () => {
    const { PetroglyphPlugin } = await import("./main.js");
    const plugin = new PetroglyphPlugin({} as App, {} as PluginManifest);
    plugin.loadData = vi.fn(async () => null);
    plugin.saveData = vi.fn();
    plugin.registerObsidianProtocolHandler = vi.fn();
    plugin.addSettingTab = vi.fn();
    // @ts-expect-error — minimal stub
    plugin.app = {};

    const scheduleRefreshSpy = vi.spyOn(plugin, "scheduleRefresh").mockImplementation(() => {});

    await plugin.onload();

    expect(scheduleRefreshSpy).not.toHaveBeenCalled();
  });
});

describe("onunload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels pending refresh timeout on unload", async () => {
    const clearTimeoutMock = vi.fn();
    vi.stubGlobal("window", {
      setTimeout: vi.fn().mockReturnValue(42),
      clearTimeout: clearTimeoutMock,
    });

    const { plugin } = await makePlugin();
    plugin.scheduleRefresh(makeTestJwt(Math.floor(Date.now() / 1000) + 3600));

    plugin.onunload();

    expect(clearTimeoutMock).toHaveBeenCalledWith(42);
  });

  it("does not throw when no pending timeout exists", async () => {
    vi.stubGlobal("window", {
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });

    const { plugin } = await makePlugin();

    expect(() => plugin.onunload()).not.toThrow();
  });
});

describe("openOneDriveAuthUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("calls GET /onedrive/auth-url with JWT Bearer and opens the URL", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", refreshToken: "r", username: "alice" });
    vi.stubGlobal("window", { open: vi.fn() });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://onedrive.auth.url" }),
    });

    await plugin.openOneDriveAuthUrl();

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/onedrive/auth-url",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }),
      }),
    );
    expect(window.open).toHaveBeenCalledWith("https://onedrive.auth.url", "_blank");
  });

  it("shows notice when response is not ok", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    await plugin.openOneDriveAuthUrl();

    expect(Notice).toHaveBeenCalledWith("Failed to get OneDrive auth URL");
  });

  it("shows notice when response body has no url field", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ notUrl: 42 }),
    });

    await plugin.openOneDriveAuthUrl();

    expect(Notice).toHaveBeenCalledWith("Failed to get OneDrive auth URL");
  });

  it("shows notice on fetch error", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await plugin.openOneDriveAuthUrl();

    expect(Notice).toHaveBeenCalledWith("Failed to get OneDrive auth URL");
  });
});

describe("handleOneDriveCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("sets oneDriveConnected=true and saves data on success", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", refreshToken: "r", username: "alice" });

    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    await plugin.handleOneDriveCallback({ code: "abc", state: "xyz" });

    expect(plugin.data.oneDriveConnected).toBe(true);
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({ oneDriveConnected: true }),
    );
  });

  it("calls POST /onedrive/connect with JWT Bearer and params", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", refreshToken: "r", username: "alice" });

    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    await plugin.handleOneDriveCallback({ code: "abc", state: "xyz" });

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/onedrive/connect",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }),
        body: JSON.stringify({ code: "abc", state: "xyz" }),
      }),
    );
  });

  it("shows notice when response is not ok", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    await plugin.handleOneDriveCallback({ code: "bad", state: "bad" });

    expect(plugin.data.oneDriveConnected).toBeUndefined();
    expect(Notice).toHaveBeenCalledWith("OneDrive connection failed");
  });

  it("shows notice on fetch error", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await plugin.handleOneDriveCallback({ code: "err", state: "err" });

    expect(Notice).toHaveBeenCalledWith("OneDrive connection failed");
  });
});

describe("pollStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("calls GET /status with JWT Bearer", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", refreshToken: "r", username: "alice" });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ oneDrive: { connected: true } }),
    });

    await plugin.pollStatus();

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/status",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }),
      }),
    );
  });

  it("updates oneDriveConnected from response and saves data", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", refreshToken: "r", username: "alice" });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ oneDrive: { connected: true } }),
    });

    await plugin.pollStatus();

    expect(plugin.data.oneDriveConnected).toBe(true);
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({ oneDriveConnected: true }),
    );
  });

  it("does nothing when no JWT is stored", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn();

    await plugin.pollStatus();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("silently ignores network errors", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", refreshToken: "r", username: "alice" });

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(plugin.pollStatus()).resolves.not.toThrow();
  });
});

describe("status polling lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts polling interval on load when JWT is present", async () => {
    const jwt = makeTestJwt(Math.floor(Date.now() / 1000) + 3600);
    const { PetroglyphPlugin } = await import("./main.js");
    const plugin = new PetroglyphPlugin({} as App, {} as PluginManifest);
    plugin.loadData = vi.fn(async () => ({ jwt, refreshToken: "r", username: "alice", apiBaseUrl: "http://localhost:3000" }));
    plugin.saveData = vi.fn();
    plugin.registerObsidianProtocolHandler = vi.fn();
    plugin.addSettingTab = vi.fn();
    // @ts-expect-error — minimal stub
    plugin.app = {};

    const pollStatusSpy = vi.spyOn(plugin, "pollStatus").mockResolvedValue(undefined);
    vi.spyOn(plugin, "scheduleRefresh").mockImplementation(() => {});

    await plugin.onload();

    expect(pollStatusSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(pollStatusSpy).toHaveBeenCalledOnce();
  });

  it("does not start polling when no JWT on load", async () => {
    const { PetroglyphPlugin } = await import("./main.js");
    const plugin = new PetroglyphPlugin({} as App, {} as PluginManifest);
    plugin.loadData = vi.fn(async () => null);
    plugin.saveData = vi.fn();
    plugin.registerObsidianProtocolHandler = vi.fn();
    plugin.addSettingTab = vi.fn();
    // @ts-expect-error — minimal stub
    plugin.app = {};

    const pollStatusSpy = vi.spyOn(plugin, "pollStatus").mockResolvedValue(undefined);

    await plugin.onload();

    vi.advanceTimersByTime(60_000 * 10);
    expect(pollStatusSpy).not.toHaveBeenCalled();
  });

  it("does not start a second interval when startStatusPolling is called twice", async () => {
    const setIntervalMock = vi.fn().mockReturnValue(99);
    vi.stubGlobal("window", {
      ...makeWindowStub(),
      setInterval: setIntervalMock,
    });

    const { plugin } = await makePlugin();

    plugin.startStatusPolling();
    plugin.startStatusPolling();

    expect(setIntervalMock).toHaveBeenCalledOnce();
  });

  it("clears polling interval on unload", async () => {
    const clearIntervalMock = vi.fn();
    vi.stubGlobal("window", {
      setTimeout: vi.fn().mockReturnValue(1),
      clearTimeout: vi.fn(),
      setInterval: vi.fn().mockReturnValue(99),
      clearInterval: clearIntervalMock,
    });

    const jwt = makeTestJwt(Math.floor(Date.now() / 1000) + 3600);
    const { PetroglyphPlugin } = await import("./main.js");
    const plugin = new PetroglyphPlugin({} as App, {} as PluginManifest);
    plugin.loadData = vi.fn(async () => ({ jwt, refreshToken: "r", username: "alice", apiBaseUrl: "http://localhost:3000" }));
    plugin.saveData = vi.fn();
    plugin.registerObsidianProtocolHandler = vi.fn();
    plugin.addSettingTab = vi.fn();
    // @ts-expect-error — minimal stub
    plugin.app = {};

    vi.spyOn(plugin, "scheduleRefresh").mockImplementation(() => {});

    await plugin.onload();
    plugin.onunload();

    expect(clearIntervalMock).toHaveBeenCalledWith(99);
  });
});

describe("oauth/callback URI handler registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("registers petroglyph/oauth/callback handler on load", async () => {
    const { PetroglyphPlugin } = await import("./main.js");
    const plugin = new PetroglyphPlugin({} as App, {} as PluginManifest);
    plugin.loadData = vi.fn(async () => null);
    plugin.saveData = vi.fn();
    plugin.registerObsidianProtocolHandler = vi.fn();
    plugin.addSettingTab = vi.fn();
    // @ts-expect-error — minimal stub
    plugin.app = {};

    await plugin.onload();

    expect(plugin.registerObsidianProtocolHandler).toHaveBeenCalledWith(
      "petroglyph/oauth/callback",
      expect.any(Function),
    );
  });
});

describe("sync poller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts sync polling when oneDrive is connected on load", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });

    const setIntervalSpy = vi.spyOn(window, "setInterval");
    await plugin.onload();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
  });

  it("does not start sync polling when oneDrive is not connected", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: false,
    });

    const setIntervalSpy = vi.spyOn(window, "setInterval");
    await plugin.onload();

    const syncCalls = setIntervalSpy.mock.calls.filter(
      (call) => call[1] === 5 * 60 * 1000,
    );
    expect(syncCalls).toHaveLength(0);
  });

  it("stops sync polling on unload", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });

    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    await plugin.onload();
    plugin.onunload();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("fetches files and writes to vault on sync", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });

    const mockPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files/changes")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            files: [
              {
                fileId: "file-1",
                s3PresignedUrl: "https://s3.example.com/file.pdf",
                filename: "note.pdf",
                createdAt: "2026-04-11T10:00:00Z",
                pageCount: 3,
              },
            ],
            nextToken: null,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => mockPdfBytes.buffer,
      });
    }) as typeof fetch;

    const mockVault = {
      adapter: {
        exists: vi.fn(async () => false),
        mkdir: vi.fn(async () => {}),
        writeBinary: vi.fn(async () => {}),
        write: vi.fn(async () => {}),
      },
    };

    // @ts-expect-error — minimal stub
    plugin.app = { vault: mockVault };

    await plugin.performSync();

    expect(mockVault.adapter.writeBinary).toHaveBeenCalledWith(
      "handwritten/note.pdf",
      expect.any(Uint8Array),
    );
    expect(mockVault.adapter.write).toHaveBeenCalledWith(
      "handwritten/note.md",
      expect.stringContaining("source: onedrive"),
    );
    expect(mockVault.adapter.write).toHaveBeenCalledWith(
      "handwritten/note.md",
      expect.stringContaining("page_count: 3"),
    );
  });

  it("advances token after each file write", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });

    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files/changes")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            files: [
              {
                fileId: "file-1",
                s3PresignedUrl: "https://s3.example.com/file1.pdf",
                filename: "note1.pdf",
                createdAt: "2026-04-11T10:00:00Z",
              },
              {
                fileId: "file-2",
                s3PresignedUrl: "https://s3.example.com/file2.pdf",
                filename: "note2.pdf",
                createdAt: "2026-04-11T11:00:00Z",
              },
            ],
            nextToken: null,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      });
    }) as typeof fetch;

    const mockVault = {
      adapter: {
        exists: vi.fn(async () => true),
        mkdir: vi.fn(async () => {}),
        writeBinary: vi.fn(async () => {}),
        write: vi.fn(async () => {}),
      },
    };

    // @ts-expect-error — minimal stub
    plugin.app = { vault: mockVault };

    await plugin.performSync();

    expect(plugin.saveData).toHaveBeenCalledTimes(2);
    expect(plugin.data.changeTokens?.["default"]).toBe("file-2");
  });

  it("handles resetToken flag by clearing stored token", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      changeTokens: { default: "old-token" },
    });

    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files/changes")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            resetToken: true,
            files: [
              {
                fileId: "file-1",
                s3PresignedUrl: "https://s3.example.com/file1.pdf",
                filename: "note1.pdf",
                createdAt: "2026-04-11T10:00:00Z",
              },
            ],
            nextToken: null,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      });
    }) as typeof fetch;

    const mockVault = {
      adapter: {
        exists: vi.fn(async () => true),
        mkdir: vi.fn(async () => {}),
        writeBinary: vi.fn(async () => {}),
        write: vi.fn(async () => {}),
      },
    };

    // @ts-expect-error — minimal stub
    plugin.app = { vault: mockVault };

    await plugin.performSync();

    expect(plugin.data.changeTokens?.["default"]).toBe("file-1");
  });

  it("pages through multiple responses using nextToken", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });

    let callCount = 0;
    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files/changes")) {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              files: [
                {
                  fileId: "file-1",
                  s3PresignedUrl: "https://s3.example.com/file1.pdf",
                  filename: "note1.pdf",
                  createdAt: "2026-04-11T10:00:00Z",
                },
              ],
              nextToken: "page-2-token",
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            files: [
              {
                fileId: "file-2",
                s3PresignedUrl: "https://s3.example.com/file2.pdf",
                filename: "note2.pdf",
                createdAt: "2026-04-11T11:00:00Z",
              },
            ],
            nextToken: null,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      });
    }) as typeof fetch;

    const mockVault = {
      adapter: {
        exists: vi.fn(async () => true),
        mkdir: vi.fn(async () => {}),
        writeBinary: vi.fn(async () => {}),
        write: vi.fn(async () => {}),
      },
    };

    // @ts-expect-error — minimal stub
    plugin.app = { vault: mockVault };

    await plugin.performSync();

    expect(mockVault.adapter.writeBinary).toHaveBeenCalledTimes(2);
    expect(plugin.data.changeTokens?.["default"]).toBe("file-2");
  });

  it("creates missing vault folders before writing files", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });

    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files/changes")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            files: [
              {
                fileId: "file-1",
                s3PresignedUrl: "https://s3.example.com/file.pdf",
                filename: "subfolder/note.pdf",
                createdAt: "2026-04-11T10:00:00Z",
              },
            ],
            nextToken: null,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      });
    }) as typeof fetch;

    const mockVault = {
      adapter: {
        exists: vi.fn(async () => false),
        mkdir: vi.fn(async () => {}),
        writeBinary: vi.fn(async () => {}),
        write: vi.fn(async () => {}),
      },
    };

    // @ts-expect-error — minimal stub
    plugin.app = { vault: mockVault };

    await plugin.performSync();

    expect(mockVault.adapter.mkdir).toHaveBeenCalledWith("handwritten/subfolder");
  });

  it("starts sync polling when OneDrive is connected via callback", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const setIntervalSpy = vi.spyOn(window, "setInterval");

    await plugin.handleOneDriveCallback({ code: "auth-code", state: "state" });

    const syncCalls = setIntervalSpy.mock.calls.filter(
      (call) => call[1] === 5 * 60 * 1000,
    );
    expect(syncCalls.length).toBeGreaterThan(0);
  });
});

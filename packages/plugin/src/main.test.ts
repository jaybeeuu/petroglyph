import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { App, PluginManifest } from "obsidian";
import type { FeedEntry } from "./feed.js";
import type { PetroglyphPlugin } from "./main.js";

/* eslint-disable @typescript-eslint/no-extraneous-class, @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-function-return-type */
vi.mock("obsidian", () => ({
  Notice: Notice,
  Plugin: class {
    constructor(_app: unknown, _manifest: unknown) {}
  },
  PluginSettingTab: class {},
  App: class {},
  Setting: class {},
  Modal: class {
    contentEl = { empty: vi.fn(), createEl: vi.fn(() => ({})) };
    open() {}
    close() {}
  },
  normalizePath: (path: string) => path,
}));
/* eslint-enable @typescript-eslint/no-extraneous-class, @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-function-return-type */

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

function makeTestJwtWithPayload(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${encodedPayload}.fakesignature`;
}

async function makePlugin(initialData?: {
  [key: string]: unknown;
}): Promise<{ plugin: PetroglyphPlugin; savedData: { [key: string]: unknown } }> {
  const { PetroglyphPlugin: PluginClass } = await import("./main.js");

  const savedData: { [key: string]: unknown } = {};
  if (initialData !== undefined) {
    savedData["data"] = initialData;
  }

  const plugin = new PluginClass({} as App, {} as PluginManifest);

  plugin.loadData = vi.fn(() => Promise.resolve(savedData["data"] ?? null));
  plugin.saveData = vi.fn((data: unknown) => {
    savedData["data"] = data;
    return Promise.resolve();
  });
  plugin.registerObsidianProtocolHandler = vi.fn();
  plugin.addSettingTab = vi.fn();
  plugin.app = {} as App;

  await plugin.loadPluginData();

  return { plugin, savedData };
}

function makeFeedEntry(overrides: Partial<FeedEntry>): FeedEntry {
  return {
    itemId: "item-1",
    name: "note.pdf",
    relativePath: "",
    mimeType: "application/pdf",
    s3PresignedUrl: "https://s3.example.com/file.pdf",
    createdAt: "2026-04-11T10:00:00Z",
    ...overrides,
  };
}

interface VaultStub {
  adapter: {
    exists: Mock;
    mkdir: Mock;
    readBinary: Mock;
    writeBinary: Mock;
    write: Mock;
  };
}

function makeVaultStub(): VaultStub {
  return {
    adapter: {
      exists: vi.fn(() => Promise.resolve(true)),
      mkdir: vi.fn(() => Promise.resolve()),
      readBinary: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
      writeBinary: vi.fn(() => Promise.resolve()),
      write: vi.fn(() => Promise.resolve()),
    },
  };
}

/**
 * The path Obsidian's vault adapter actually resolves before it touches the
 * disk. `normalizePath` turns every `\` into `/` and collapses repeats, so a
 * backslash separator climbs the same way a forward slash does. The stub does
 * not normalise, so a test must, to see where a write really lands.
 */
function adapterPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** Every path the adapter was asked to create or write, as Obsidian resolves it. */
function writtenPaths(vault: VaultStub): string[] {
  const calls: unknown[][] = [
    ...vault.adapter.writeBinary.mock.calls,
    ...vault.adapter.write.mock.calls,
    ...vault.adapter.mkdir.mock.calls,
  ];
  return calls.map((call) => adapterPath(String(call[0])));
}

/**
 * A fetch stub for the three URLs one sync touches: GET /profiles, GET /files
 * and the presigned download, so one test can drive the whole write path.
 */
function stubSyncFetch(profile: {
  destinationVaultPath?: string;
  files: FeedEntry[];
}): typeof fetch {
  return vi.fn((url: string) => {
    if (url.includes("/profiles")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              id: "p1",
              name: "Proofs",
              sourceFolderPath: "onyx/proofs",
              destinationVaultPath: profile.destinationVaultPath ?? "",
              active: true,
            },
          ]),
      });
    }
    if (url.includes("/files")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ files: profile.files, nextToken: null }),
      });
    }
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
    });
  }) as unknown as typeof fetch;
}

/** A URL that answers with a JSON body. */
function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

/** A URL that answers with PDF bytes. */
function bytesResponse(): Response {
  return {
    ok: true,
    arrayBuffer: () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
  } as unknown as Response;
}

/** A URL that answers with an error status. */
function failureResponse(status: number): Response {
  return { ok: false, status } as unknown as Response;
}

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
      json: () => Promise.resolve({ url: "https://github.com/login/oauth/authorize?..." }),
    });

    await plugin.openAuthUrl();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.petroglyph.page/auth/url?returnUri=obsidian%3A%2F%2Fpetroglyph%2Fauth%2Fcallback",
    );
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
      json: () => Promise.resolve({ notUrl: 42 }),
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
    expect(plugin.data.apiBaseUrl).toBe("https://api.petroglyph.page");
    expect(plugin.data.jwt).toBeUndefined();
  });

  it("persists data via saveData", async () => {
    const { plugin } = await makePlugin();
    plugin.setCredentials("jwt-token", "refresh-token", "carol");
    await plugin.savePluginData();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({ username: "carol" }));
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

function makeWindowStub(): {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
} {
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

  it("shows a notice and does not schedule when the JWT payload has no exp field", async () => {
    const { plugin } = await makePlugin();
    const performRefreshSpy = vi.spyOn(plugin, "performRefresh").mockResolvedValue(undefined);

    plugin.scheduleRefresh(makeTestJwtWithoutExp());

    expect(Notice).toHaveBeenCalledWith("Invalid session token: please sign in again.");
    vi.advanceTimersByTime(999_999_999);
    expect(performRefreshSpy).not.toHaveBeenCalled();
  });

  it("shows a notice and does not schedule when the JWT is malformed", async () => {
    const { plugin } = await makePlugin();
    const performRefreshSpy = vi.spyOn(plugin, "performRefresh").mockResolvedValue(undefined);

    plugin.scheduleRefresh("not-a-jwt");
    plugin.scheduleRefresh("two.parts");
    plugin.scheduleRefresh("four.parts.are.too.many");

    expect(Notice).toHaveBeenCalledWith("Invalid session token: please sign in again.");
    vi.advanceTimersByTime(999_999_999);
    expect(performRefreshSpy).not.toHaveBeenCalled();
  });

  it("shows a notice and does not schedule when the JWT payload is not valid JSON", async () => {
    const { plugin } = await makePlugin();
    const performRefreshSpy = vi.spyOn(plugin, "performRefresh").mockResolvedValue(undefined);

    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const garbagePayload = Buffer.from("{{ not json").toString("base64url");
    plugin.scheduleRefresh(`${header}.${garbagePayload}.fakesignature`);

    expect(Notice).toHaveBeenCalledWith("Invalid session token: please sign in again.");
    vi.advanceTimersByTime(999_999_999);
    expect(performRefreshSpy).not.toHaveBeenCalled();
  });

  it("shows a notice and does not schedule when the JWT payload exp is not a number", async () => {
    const { plugin } = await makePlugin();
    const performRefreshSpy = vi.spyOn(plugin, "performRefresh").mockResolvedValue(undefined);

    plugin.scheduleRefresh(makeTestJwtWithPayload({ sub: "test", exp: "soon" }));

    expect(Notice).toHaveBeenCalledWith("Invalid session token: please sign in again.");
    vi.advanceTimersByTime(999_999_999);
    expect(performRefreshSpy).not.toHaveBeenCalled();
  });

  it("shows a notice and does not schedule when the JWT payload is not an object", async () => {
    const { plugin } = await makePlugin();
    const performRefreshSpy = vi.spyOn(plugin, "performRefresh").mockResolvedValue(undefined);

    plugin.scheduleRefresh(makeTestJwtWithPayload("a string"));

    expect(Notice).toHaveBeenCalledWith("Invalid session token: please sign in again.");
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
      json: () => Promise.resolve({ jwt: newJwt, refreshToken: "new-refresh" }),
    });

    await plugin.performRefresh();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.petroglyph.page/auth/refresh",
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
      json: () => Promise.resolve({ jwt: newJwt, refreshToken: "new-refresh" }),
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
    plugin.loadData = vi.fn(() =>
      Promise.resolve({
        jwt,
        refreshToken: "r",
        username: "alice",
        apiBaseUrl: "http://localhost:3000",
      }),
    );
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
    plugin.loadData = vi.fn(() => Promise.resolve(null));
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

    expect(() => {
      plugin.onunload();
    }).not.toThrow();
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
      json: () => Promise.resolve({ url: "https://onedrive.auth.url" }),
    });

    await plugin.openOneDriveAuthUrl();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.petroglyph.page/onedrive/auth-url",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }) as unknown as {
          [key: string]: string;
        },
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
      json: () => Promise.resolve({ notUrl: 42 }),
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

  it("sets oneDriveConnected=true and oneDriveStatus=connected on success", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", refreshToken: "r", username: "alice" });
    const refreshSettingsUiSpy = vi.spyOn(plugin, "refreshSettingsUi").mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await plugin.handleOneDriveCallback({ code: "abc", state: "xyz" });

    expect(plugin.data.oneDriveConnected).toBe(true);
    expect(plugin.data.oneDriveStatus).toBe("connected");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({ oneDriveConnected: true, oneDriveStatus: "connected" }),
    );
    expect(refreshSettingsUiSpy).toHaveBeenCalledOnce();
  });

  it("calls POST /onedrive/connect with JWT Bearer and params", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", refreshToken: "r", username: "alice" });

    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await plugin.handleOneDriveCallback({ code: "abc", state: "xyz" });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.petroglyph.page/onedrive/connect",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }) as unknown as {
          [key: string]: string;
        },
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
      json: () => Promise.resolve({ oneDrive: { connected: true } }),
    });

    await plugin.pollStatus();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.petroglyph.page/status",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }) as unknown as {
          [key: string]: string;
        },
      }),
    );
  });

  it("updates oneDriveConnected from response and saves data", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", refreshToken: "r", username: "alice" });
    const refreshSettingsUiSpy = vi.spyOn(plugin, "refreshSettingsUi").mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ oneDrive: { connected: true } }),
    });

    await plugin.pollStatus();

    expect(plugin.data.oneDriveConnected).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({ oneDriveConnected: true }),
    );
    expect(refreshSettingsUiSpy).toHaveBeenCalledOnce();
  });

  it("refreshes settings when status polling updates oneDriveStatus", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      refreshToken: "r",
      username: "alice",
      oneDriveStatus: "ok",
    });
    const refreshSettingsUiSpy = vi.spyOn(plugin, "refreshSettingsUi").mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ oneDrive: { status: "reconnect_required" } }),
    });

    await plugin.pollStatus();

    expect(plugin.data.oneDriveStatus).toBe("reconnect_required");
    expect(refreshSettingsUiSpy).toHaveBeenCalledOnce();
  });

  it("does nothing when no JWT is stored", async () => {
    const { plugin } = await makePlugin();

    global.fetch = vi.fn();

    await plugin.pollStatus();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reads oneDriveStatus from top-level response field", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      refreshToken: "r",
      username: "alice",
    });
    const refreshSettingsUiSpy = vi.spyOn(plugin, "refreshSettingsUi").mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ oneDriveStatus: "connected" }),
    });

    await plugin.pollStatus();

    expect(plugin.data.oneDriveStatus).toBe("connected");
    expect(refreshSettingsUiSpy).toHaveBeenCalledOnce();
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
    plugin.loadData = vi.fn(() =>
      Promise.resolve({
        jwt,
        refreshToken: "r",
        username: "alice",
        apiBaseUrl: "http://localhost:3000",
      }),
    );
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
    plugin.loadData = vi.fn(() => Promise.resolve(null));
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
    plugin.loadData = vi.fn(() =>
      Promise.resolve({
        jwt,
        refreshToken: "r",
        username: "alice",
        apiBaseUrl: "http://localhost:3000",
      }),
    );
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

describe("petroglyph/auth/callback URI handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("registers credentials and starts auth state after successful callback", async () => {
    const { plugin } = await makePlugin();
    const savePluginDataSpy = vi.spyOn(plugin, "savePluginData").mockResolvedValue(undefined);
    const scheduleRefreshSpy = vi.spyOn(plugin, "scheduleRefresh").mockImplementation(() => {});
    const startStatusPollingSpy = vi
      .spyOn(plugin, "startStatusPolling")
      .mockImplementation(() => {});
    const refreshSettingsUiSpy = vi.spyOn(plugin, "refreshSettingsUi").mockImplementation(() => {});

    await plugin.onload();

    const registerProtocolHandler = plugin.registerObsidianProtocolHandler; // eslint-disable-line @typescript-eslint/unbound-method
    const handler = vi
      .mocked(registerProtocolHandler)
      .mock.calls.find((call) => call[0] === "petroglyph/auth/callback")?.[1];

    expect(handler).toBeTypeOf("function");

    await handler?.({
      action: "callback",
      jwt: "jwt-token",
      refreshToken: "refresh-token",
      username: "alice",
    });

    expect(plugin.data.jwt).toBe("jwt-token");
    expect(plugin.data.refreshToken).toBe("refresh-token");
    expect(plugin.data.username).toBe("alice");
    expect(savePluginDataSpy).toHaveBeenCalledOnce();
    expect(scheduleRefreshSpy).toHaveBeenCalledWith("jwt-token");
    expect(startStatusPollingSpy).toHaveBeenCalledOnce();
    expect(refreshSettingsUiSpy).toHaveBeenCalledOnce();
    expect(Notice).toHaveBeenCalledWith("Logged in as @alice");
  });

  it("shows login failed when auth params are missing", async () => {
    const { plugin } = await makePlugin();
    const savePluginDataSpy = vi.spyOn(plugin, "savePluginData").mockResolvedValue(undefined);
    const scheduleRefreshSpy = vi.spyOn(plugin, "scheduleRefresh").mockImplementation(() => {});
    const startStatusPollingSpy = vi
      .spyOn(plugin, "startStatusPolling")
      .mockImplementation(() => {});

    await plugin.onload();

    const registerProtocolHandler = plugin.registerObsidianProtocolHandler; // eslint-disable-line @typescript-eslint/unbound-method
    const handler = vi
      .mocked(registerProtocolHandler)
      .mock.calls.find((call) => call[0] === "petroglyph/auth/callback")?.[1];

    expect(handler).toBeTypeOf("function");

    await handler?.({ action: "callback", jwt: "jwt-token", username: "alice" });

    expect(plugin.data.jwt).toBeUndefined();
    expect(plugin.data.refreshToken).toBeUndefined();
    expect(plugin.data.username).toBeUndefined();
    expect(savePluginDataSpy).not.toHaveBeenCalled();
    expect(scheduleRefreshSpy).not.toHaveBeenCalled();
    expect(startStatusPollingSpy).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith("Login failed: missing auth params");
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
    plugin.loadData = vi.fn(() => Promise.resolve(null));
    plugin.saveData = vi.fn();
    plugin.registerObsidianProtocolHandler = vi.fn();
    plugin.addSettingTab = vi.fn();
    // @ts-expect-error — minimal stub
    plugin.app = {};

    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.registerObsidianProtocolHandler).toHaveBeenCalledWith(
      "petroglyph/oauth/callback",
      expect.any(Function),
    );
  });
});

describe("syncNow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pages GET /files and reports completion", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ files: [], nextToken: null }),
    });

    await plugin.syncNow();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.petroglyph.page/files",
      expect.objectContaining({
        headers: { Authorization: "Bearer jwt-token" },
      }),
    );
    expect(Notice).toHaveBeenCalledWith("Sync complete");
  });

  it("does not reach the API when OneDrive is not connected", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: false,
    });
    global.fetch = vi.fn();

    await plugin.syncNow();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith("Not connected. Cannot sync.");
  });

  it("shows an error notice when the feed request is rejected", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    await plugin.syncNow();

    expect(Notice).toHaveBeenCalledWith("Sync failed: error fetching files");
    expect(Notice).not.toHaveBeenCalledWith("Sync complete");
  });

  it("shows an error notice when the feed payload does not match the contract", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ files: [{ itemId: "item-1" }], nextToken: null }),
    });

    await plugin.syncNow();

    expect(Notice).toHaveBeenCalledWith("Sync failed: invalid files list");
  });

  it("shows a network error notice when the feed request throws", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });
    global.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await plugin.syncNow();

    expect(Notice).toHaveBeenCalledWith("Sync failed: network or server error");
  });
});

describe("feed sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("writes each feed file into the vault under its relative path", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });

    const mockPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              files: [
                {
                  itemId: "item-1",
                  name: "note.pdf",
                  relativePath: "notes/2026",
                  mimeType: "application/pdf",
                  s3PresignedUrl: "https://s3.example.com/file.pdf",
                  createdAt: "2026-04-11T10:00:00Z",
                },
              ],
              nextToken: null,
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockPdfBytes.buffer),
      });
    }) as unknown as typeof fetch;

    const mockVault = {
      adapter: {
        exists: vi.fn(() => Promise.resolve(false)),
        mkdir: vi.fn(() => Promise.resolve()),
        readBinary: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
        writeBinary: vi.fn(() => Promise.resolve()),
        write: vi.fn(() => Promise.resolve()),
      },
    };

    // @ts-expect-error — minimal stub
    plugin.app = { vault: mockVault };

    await plugin.performSync();

    expect(mockVault.adapter.writeBinary).toHaveBeenCalledWith(
      "handwritten/notes/2026/note.pdf",
      expect.any(Uint8Array),
    );
    expect(mockVault.adapter.write).toHaveBeenCalledWith(
      "handwritten/notes/2026/note.md",
      expect.stringContaining("source: onedrive"),
    );
  });

  it("creates the destination folder before writing", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });

    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              files: [
                {
                  itemId: "item-1",
                  name: "note.pdf",
                  relativePath: "subfolder",
                  mimeType: "application/pdf",
                  s3PresignedUrl: "https://s3.example.com/file.pdf",
                  createdAt: "2026-04-11T10:00:00Z",
                },
              ],
              nextToken: null,
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      });
    }) as unknown as typeof fetch;

    const mockVault = {
      adapter: {
        exists: vi.fn(() => Promise.resolve(false)),
        mkdir: vi.fn(() => Promise.resolve()),
        readBinary: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
        writeBinary: vi.fn(() => Promise.resolve()),
        write: vi.fn(() => Promise.resolve()),
      },
    };

    // @ts-expect-error — minimal stub
    plugin.app = { vault: mockVault };

    await plugin.performSync();

    expect(mockVault.adapter.mkdir).toHaveBeenCalledWith("handwritten/subfolder");
  });

  it("leaves an already-current file untouched", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });

    const currentBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              files: [
                {
                  itemId: "item-1",
                  name: "note.pdf",
                  relativePath: "",
                  mimeType: "application/pdf",
                  s3PresignedUrl: "https://s3.example.com/file.pdf",
                  createdAt: "2026-04-11T10:00:00Z",
                },
              ],
              nextToken: null,
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(currentBytes.buffer),
      });
    }) as unknown as typeof fetch;

    const mockVault = {
      adapter: {
        exists: vi.fn(() => Promise.resolve(true)),
        mkdir: vi.fn(() => Promise.resolve()),
        readBinary: vi.fn(() => Promise.resolve(currentBytes.buffer)),
        writeBinary: vi.fn(() => Promise.resolve()),
        write: vi.fn(() => Promise.resolve()),
      },
    };

    // @ts-expect-error — minimal stub
    plugin.app = { vault: mockVault };

    await plugin.performSync();

    expect(mockVault.adapter.writeBinary).not.toHaveBeenCalled();
    expect(mockVault.adapter.write).not.toHaveBeenCalled();
  });

  it("pages through the feed using nextToken", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });

    let callCount = 0;
    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files")) {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                files: [
                  {
                    itemId: "item-1",
                    name: "note1.pdf",
                    relativePath: "",
                    mimeType: "application/pdf",
                    s3PresignedUrl: "https://s3.example.com/file1.pdf",
                    createdAt: "2026-04-11T10:00:00Z",
                  },
                ],
                nextToken: "page-2-cursor",
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              files: [
                {
                  itemId: "item-2",
                  name: "note2.pdf",
                  relativePath: "",
                  mimeType: "application/pdf",
                  s3PresignedUrl: "https://s3.example.com/file2.pdf",
                  createdAt: "2026-04-11T11:00:00Z",
                },
              ],
              nextToken: null,
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      });
    }) as unknown as typeof fetch;

    const mockVault = {
      adapter: {
        exists: vi.fn(() => Promise.resolve(true)),
        mkdir: vi.fn(() => Promise.resolve()),
        readBinary: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
        writeBinary: vi.fn(() => Promise.resolve()),
        write: vi.fn(() => Promise.resolve()),
      },
    };

    // @ts-expect-error — minimal stub
    plugin.app = { vault: mockVault };

    await plugin.performSync();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.petroglyph.page/files?nextToken=page-2-cursor",
      expect.anything(),
    );
    expect(mockVault.adapter.writeBinary).toHaveBeenCalledTimes(2);
  });

  it("pages from the stored cursor for the active profile", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      activeProfileId: "p2",
      feedCursors: { p2: "after-p2" },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ files: [], nextToken: null }),
    });

    await plugin.performSync();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.petroglyph.page/files?nextToken=after-p2",
      expect.anything(),
    );
  });

  it("clears a rejected cursor and re-pages from the head of the feed", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      feedCursors: { default: "stale-cursor" },
    });

    const requestedUrls: string[] = [];
    global.fetch = vi.fn((url) => {
      if (typeof url !== "string" || !url.includes("/files")) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        });
      }
      requestedUrls.push(url);
      if (url.includes("nextToken=stale-cursor")) {
        return Promise.resolve({ ok: false, status: 400 });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            files: [
              {
                itemId: "item-1",
                name: "note.pdf",
                relativePath: "",
                mimeType: "application/pdf",
                s3PresignedUrl: "https://s3.example.com/file.pdf",
                createdAt: "2026-04-11T10:00:00Z",
              },
            ],
            nextToken: null,
          }),
      });
    }) as unknown as typeof fetch;

    const mockVault = {
      adapter: {
        exists: vi.fn(() => Promise.resolve(true)),
        mkdir: vi.fn(() => Promise.resolve()),
        readBinary: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
        writeBinary: vi.fn(() => Promise.resolve()),
        write: vi.fn(() => Promise.resolve()),
      },
    };

    // @ts-expect-error — minimal stub
    plugin.app = { vault: mockVault };

    await plugin.performSync();

    expect(requestedUrls).toEqual([
      "https://api.petroglyph.page/files?nextToken=stale-cursor",
      "https://api.petroglyph.page/files",
    ]);
    expect(mockVault.adapter.writeBinary).toHaveBeenCalledWith(
      "handwritten/note.pdf",
      expect.any(Uint8Array),
    );
  });

  it("gives up rather than looping when a cursor is rejected twice", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      feedCursors: { default: "stale-cursor" },
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });

    await plugin.performSync();

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("clears the stored cursor once the feed is exhausted", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      feedCursors: { default: "old-cursor" },
    });
    let callCount = 0;
    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files")) {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ files: [], nextToken: null }),
        });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    }) as unknown as typeof fetch;

    await plugin.performSync();

    expect(callCount).toBe(1);
    expect(plugin.data.feedCursors?.["default"]).toBeUndefined();
  });

  it("keeps the mid-feed cursor when a later page fails", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });
    let callCount = 0;
    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files")) {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ files: [], nextToken: "page-2-cursor" }),
          });
        }
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    }) as unknown as typeof fetch;

    await plugin.performSync();

    expect(plugin.data.feedCursors?.["default"]).toBe("page-2-cursor");
  });

  it("gives up when the feed cursor never advances", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ files: [], nextToken: "same-cursor" }),
    });

    const { MAX_FEED_PAGES } = await import("./main.js");
    await plugin.performSync();

    expect(global.fetch).toHaveBeenCalledTimes(MAX_FEED_PAGES);
  });
});

describe("destination vault path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("writes the file and its companion note under the profile's destination", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    const vault = makeVaultStub();
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    global.fetch = stubSyncFetch({
      destinationVaultPath: "twiy-proof",
      files: [makeFeedEntry({ name: "note.pdf", relativePath: "notes/2026" })],
    });

    await plugin.loadProfiles();
    await plugin.performSync();

    expect(vault.adapter.writeBinary).toHaveBeenCalledWith(
      "twiy-proof/notes/2026/note.pdf",
      expect.any(Uint8Array),
    );
    expect(vault.adapter.write).toHaveBeenCalledWith(
      "twiy-proof/notes/2026/note.md",
      expect.any(String),
    );
  });

  it("writes under the default root when the profile names no destination", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    const vault = makeVaultStub();
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    global.fetch = stubSyncFetch({
      destinationVaultPath: "",
      files: [makeFeedEntry({ name: "note.pdf", relativePath: "notes/2026" })],
    });

    await plugin.loadProfiles();
    await plugin.performSync();

    expect(vault.adapter.writeBinary).toHaveBeenCalledWith(
      "handwritten/notes/2026/note.pdf",
      expect.any(Uint8Array),
    );
    expect(vault.adapter.write).toHaveBeenCalledWith(
      "handwritten/notes/2026/note.md",
      expect.any(String),
    );
  });

  it("normalises slashes around the destination", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    const vault = makeVaultStub();
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    global.fetch = stubSyncFetch({
      destinationVaultPath: "//twiy-proof//",
      files: [makeFeedEntry({ name: "note.pdf", relativePath: "notes" })],
    });

    await plugin.loadProfiles();
    await plugin.performSync();

    expect(vault.adapter.writeBinary).toHaveBeenCalledWith(
      "twiy-proof/notes/note.pdf",
      expect.any(Uint8Array),
    );
  });

  it("writes nothing when the destination escapes the vault", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    const vault = makeVaultStub();
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    global.fetch = stubSyncFetch({
      destinationVaultPath: "../outside",
      files: [makeFeedEntry({ name: "note.pdf", relativePath: "notes" })],
    });

    await plugin.loadProfiles();
    await plugin.syncNow();

    expect(writtenPaths(vault)).toEqual([]);
    expect(Notice).toHaveBeenCalledWith("Sync failed: destination path is not inside the vault");
  });

  it.each(["..\\x", "..\\..", "a\\..\\..\\b", "../..", "a/../../b", "..\\../x"])(
    "writes nothing when the destination %j escapes through any separator",
    async (destinationVaultPath) => {
      const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
      const vault = makeVaultStub();
      // @ts-expect-error — minimal stub
      plugin.app = { vault };
      global.fetch = stubSyncFetch({
        destinationVaultPath,
        files: [makeFeedEntry({ name: "note.pdf", relativePath: "notes" })],
      });

      await plugin.loadProfiles();
      await plugin.syncNow();

      expect(writtenPaths(vault)).toEqual([]);
      expect(Notice).toHaveBeenCalledWith("Sync failed: destination path is not inside the vault");
    },
  );

  it("writes a nested destination as a folder inside the vault", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    const vault = makeVaultStub();
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    global.fetch = stubSyncFetch({
      destinationVaultPath: "notes/sub",
      files: [makeFeedEntry({ name: "note.pdf", relativePath: "2026" })],
    });

    await plugin.loadProfiles();
    await plugin.performSync();

    expect(writtenPaths(vault)).toEqual(["notes/sub/2026/note.pdf", "notes/sub/2026/note.md"]);
  });

  it("writes nothing for a feed entry whose relative path escapes the vault", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    const vault = makeVaultStub();
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    global.fetch = stubSyncFetch({
      destinationVaultPath: "twiy-proof",
      files: [makeFeedEntry({ name: "note.pdf", relativePath: "../../etc" })],
    });

    await plugin.loadProfiles();
    await plugin.syncNow();

    expect(writtenPaths(vault)).toEqual([]);
    expect(Notice).toHaveBeenCalledWith("Sync failed: 1 of 1 files failed");
  });
});

describe("failed downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports how many files failed to download", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    global.fetch = vi.fn((url: string) => {
      if (url.includes("/files")) {
        return Promise.resolve(
          jsonResponse({
            files: [
              makeFeedEntry({ itemId: "item-1", s3PresignedUrl: "https://s3.example.com/ok.pdf" }),
              makeFeedEntry({
                itemId: "item-2",
                s3PresignedUrl: "https://s3.example.com/lost.pdf",
              }),
            ],
            nextToken: null,
          }),
        );
      }
      if (url === "https://s3.example.com/lost.pdf") {
        return Promise.resolve(failureResponse(403));
      }
      return Promise.resolve(bytesResponse());
    }) as unknown as typeof fetch;
    // @ts-expect-error — minimal stub
    plugin.app = { vault: makeVaultStub() };

    await plugin.syncNow();

    expect(Notice).toHaveBeenCalledWith("Sync complete: 1 file, 1 failed");
  });

  it("reports a failed sync when every download fails", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    global.fetch = vi.fn((url: string) => {
      if (url.includes("/files")) {
        return Promise.resolve(
          jsonResponse({
            files: [
              makeFeedEntry({ itemId: "item-1", s3PresignedUrl: "https://s3.example.com/one.pdf" }),
              makeFeedEntry({ itemId: "item-2", s3PresignedUrl: "https://s3.example.com/two.pdf" }),
            ],
            nextToken: null,
          }),
        );
      }
      return Promise.resolve(failureResponse(403));
    }) as unknown as typeof fetch;
    // @ts-expect-error — minimal stub
    plugin.app = { vault: makeVaultStub() };

    await plugin.syncNow();

    expect(Notice).toHaveBeenCalledWith("Sync failed: 2 of 2 files failed");
  });

  it("counts a vault write error as a failed file", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    global.fetch = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/files")
          ? jsonResponse({ files: [makeFeedEntry({})], nextToken: null })
          : bytesResponse(),
      ),
    ) as unknown as typeof fetch;
    const vault = makeVaultStub();
    vault.adapter.writeBinary = vi.fn(() => Promise.reject(new Error("disk full")));
    // @ts-expect-error — minimal stub
    plugin.app = { vault };

    await plugin.syncNow();

    expect(Notice).toHaveBeenCalledWith("Sync failed: 1 of 1 files failed");
  });

  it("reports plain completion when every file syncs", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    global.fetch = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/files")
          ? jsonResponse({ files: [makeFeedEntry({})], nextToken: null })
          : bytesResponse(),
      ),
    ) as unknown as typeof fetch;
    // @ts-expect-error — minimal stub
    plugin.app = { vault: makeVaultStub() };

    await plugin.syncNow();

    expect(Notice).toHaveBeenCalledWith("Sync complete");
  });

  it("does not advance the cursor past a page whose files failed", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    const filesRequests: string[] = [];
    global.fetch = vi.fn((url: string) => {
      if (url.includes("/files")) {
        filesRequests.push(url);
        return Promise.resolve(
          jsonResponse({ files: [makeFeedEntry({})], nextToken: "page-2-cursor" }),
        );
      }
      return Promise.resolve(failureResponse(403));
    }) as unknown as typeof fetch;
    // @ts-expect-error — minimal stub
    plugin.app = { vault: makeVaultStub() };

    await plugin.performSync();

    expect(filesRequests).toEqual(["https://api.petroglyph.page/files"]);
    expect(plugin.data.feedCursors?.["default"]).toBeUndefined();
  });

  it("keeps the earlier cursor when a later page has failed files", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    let page = 0;
    global.fetch = vi.fn((url: string) => {
      if (url.includes("/files")) {
        page += 1;
        return Promise.resolve(
          jsonResponse(
            page === 1
              ? { files: [], nextToken: "page-2-cursor" }
              : { files: [makeFeedEntry({})], nextToken: "page-3-cursor" },
          ),
        );
      }
      return Promise.resolve(failureResponse(403));
    }) as unknown as typeof fetch;
    // @ts-expect-error — minimal stub
    plugin.app = { vault: makeVaultStub() };

    await plugin.performSync();

    expect(plugin.data.feedCursors?.["default"]).toBe("page-2-cursor");
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

    const syncCalls = setIntervalSpy.mock.calls.filter((call) => call[1] === 5 * 60 * 1000);
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

  it("starts sync polling when OneDrive is connected via callback", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const setIntervalSpy = vi.spyOn(window, "setInterval");

    await plugin.handleOneDriveCallback({ code: "auth-code", state: "state" });

    const syncCalls = setIntervalSpy.mock.calls.filter((call) => call[1] === 5 * 60 * 1000);
    expect(syncCalls.length).toBeGreaterThan(0);
  });
});

describe("loadProfiles", () => {
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

  it("does nothing when no jwt is set", async () => {
    const { plugin } = await makePlugin();
    global.fetch = vi.fn();
    await plugin.loadProfiles();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches GET /profiles and stores profiles in data", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });

    const mockProfiles = [
      {
        id: "p1",
        name: "Profile 1",
        sourceFolderPath: "/src",
        destinationVaultPath: "/dst",
        active: true,
      },
    ];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockProfiles),
    });

    await plugin.loadProfiles();

    expect(plugin.data.profiles).toHaveLength(1);
    expect(plugin.data.profiles?.[0]?.name).toBe("Profile 1");
  });

  it("removes stale change tokens for deleted profile IDs", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      feedCursors: { p1: "token1", p2: "token2" },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: "p1", name: "Profile 1", sourceFolderPath: "/src", destinationVaultPath: "/dst" },
        ]),
    });

    await plugin.loadProfiles();

    expect(plugin.data.feedCursors?.["p1"]).toBe("token1");
    expect(plugin.data.feedCursors?.["p2"]).toBeUndefined();
  });

  it("syncs activeProfileId from the profile returned with active: true", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: "p1",
            name: "Profile 1",
            sourceFolderPath: "/src",
            destinationVaultPath: "/dst",
            active: false,
          },
          {
            id: "p2",
            name: "Profile 2",
            sourceFolderPath: "/src2",
            destinationVaultPath: "/dst2",
            active: true,
          },
        ]),
    });

    await plugin.loadProfiles();

    expect(plugin.data.activeProfileId).toBe("p2");
  });

  it("does not overwrite activeProfileId when no profile is active in API response", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", activeProfileId: "p1" });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: "p1",
            name: "Profile 1",
            sourceFolderPath: "/src",
            destinationVaultPath: "/dst",
            active: false,
          },
        ]),
    });

    await plugin.loadProfiles();

    expect(plugin.data.activeProfileId).toBe("p1");
  });

  it("saves plugin data after fetching profiles", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: "p1", name: "P1", sourceFolderPath: "/s", destinationVaultPath: "/d" },
        ]),
    });

    await plugin.loadProfiles();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.saveData).toHaveBeenCalled();
  });

  it("ignores non-ok responses", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });

    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    await plugin.loadProfiles();

    expect(plugin.data.profiles).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.saveData).not.toHaveBeenCalled();
  });
});

describe("setActiveProfile", () => {
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

  it("does nothing when no jwt is set", async () => {
    const { plugin } = await makePlugin();
    global.fetch = vi.fn();
    await plugin.setActiveProfile("p1");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("calls PUT /profiles/{id} with active: true", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    await plugin.setActiveProfile("p1");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/profiles/p1"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ active: true }),
      }),
    );
  });

  it("stores activeProfileId in data and saves", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    await plugin.setActiveProfile("p1");

    expect(plugin.data.activeProfileId).toBe("p1");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({ activeProfileId: "p1" }),
    );
  });

  it("shows notice on failure", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    await plugin.setActiveProfile("p1");

    expect(Notice).toHaveBeenCalledWith("Failed to set active profile");
    expect(plugin.data.activeProfileId).toBeUndefined();
  });
});

describe("activeProfileId persistence", () => {
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

  it("loads activeProfileId from saved data", async () => {
    const { plugin } = await makePlugin({ activeProfileId: "p42" });
    expect(plugin.data.activeProfileId).toBe("p42");
  });
});

describe("createProfile", () => {
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

  it("does nothing when no jwt is set", async () => {
    const { plugin } = await makePlugin();
    global.fetch = vi.fn();
    await plugin.createProfile({
      name: "New",
      sourceFolderPath: "/src",
      destinationVaultPath: "/dst",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("calls POST /profiles with the profile data", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await plugin.createProfile({
      name: "My Profile",
      sourceFolderPath: "/src",
      destinationVaultPath: "/dst",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/profiles"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "My Profile",
          sourceFolderPath: "/src",
          destinationVaultPath: "/dst",
        }),
      }),
    );
  });

  it("calls loadProfiles after successful creation", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    const mockProfiles = [
      { id: "p1", name: "My Profile", sourceFolderPath: "/src", destinationVaultPath: "/dst" },
    ];
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockProfiles) });

    await plugin.createProfile({
      name: "My Profile",
      sourceFolderPath: "/src",
      destinationVaultPath: "/dst",
    });

    expect(plugin.data.profiles).toHaveLength(1);
  });

  it("shows notice and does not call loadProfiles on API failure", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    await plugin.createProfile({
      name: "Fail",
      sourceFolderPath: "/s",
      destinationVaultPath: "/d",
    });

    expect(Notice).toHaveBeenCalledWith("Failed to create profile");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("editProfile", () => {
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

  it("does nothing when no jwt is set", async () => {
    const { plugin } = await makePlugin();
    global.fetch = vi.fn();
    await plugin.editProfile("p1", { name: "Updated" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("calls PUT /profiles/{id} with the updates", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });

    await plugin.editProfile("p1", { name: "Updated Name", sourceFolderPath: "/new-src" });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/profiles/p1"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ name: "Updated Name", sourceFolderPath: "/new-src" }),
      }),
    );
  });

  it("calls loadProfiles after successful edit", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    const updatedProfiles = [
      {
        id: "p1",
        name: "Updated Name",
        sourceFolderPath: "/new-src",
        destinationVaultPath: "/dst",
      },
    ];
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(updatedProfiles) });

    await plugin.editProfile("p1", { name: "Updated Name" });

    expect(plugin.data.profiles?.[0]?.name).toBe("Updated Name");
  });

  it("shows notice and does not call loadProfiles on API failure", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    await plugin.editProfile("p1", { name: "Fail" });

    expect(Notice).toHaveBeenCalledWith("Failed to edit profile");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("deleteProfile", () => {
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

  it("does nothing when no jwt is set", async () => {
    const { plugin } = await makePlugin();
    global.fetch = vi.fn();
    await plugin.deleteProfile("p1");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("calls DELETE /profiles/{id}", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });

    await plugin.deleteProfile("p1");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/profiles/p1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("calls loadProfiles after successful deletion", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      profiles: [
        { id: "p1", name: "P1", sourceFolderPath: "/s", destinationVaultPath: "/d" },
        { id: "p2", name: "P2", sourceFolderPath: "/s2", destinationVaultPath: "/d2" },
      ],
    });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: "p2", name: "P2", sourceFolderPath: "/s2", destinationVaultPath: "/d2" },
          ]),
      });

    await plugin.deleteProfile("p1");

    expect(plugin.data.profiles).toHaveLength(1);
    expect(plugin.data.profiles?.[0]?.id).toBe("p2");
  });

  it("clears activeProfileId when the active profile is deleted", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", activeProfileId: "p1" });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

    await plugin.deleteProfile("p1");

    expect(plugin.data.activeProfileId).toBeUndefined();
  });

  it("does not clear activeProfileId when a different profile is deleted", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", activeProfileId: "p2" });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

    await plugin.deleteProfile("p1");

    expect(plugin.data.activeProfileId).toBe("p2");
  });

  it("shows notice and does not call loadProfiles on API failure", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    await plugin.deleteProfile("p1");

    expect(Notice).toHaveBeenCalledWith("Failed to delete profile");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("state-changed emissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs a handler that re-subscribes during the emission only once", async () => {
    const { plugin } = await makePlugin();
    const handler = vi.fn();
    let resubscriptions = 0;
    const resubscribing = (): void => {
      handler();
      // Mirrors the settings tab, which re-registers itself while rendering.
      // Capped so the buggy implementation fails the assertion instead of
      // recursing until the stack overflows.
      if (resubscriptions < 5) {
        resubscriptions += 1;
        plugin.on("state-changed", resubscribing);
      }
    };
    plugin.on("state-changed", resubscribing);

    plugin.refreshSettingsUi();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("diagnostics log", () => {
  /** An in-memory vault adapter that keeps the log file in `files`. */
  function createLogSink(): {
    files: { [path: string]: string };
    adapter: {
      append: (path: string, data: string) => Promise<void>;
      read: (path: string) => Promise<string>;
      rename: (fromPath: string, toPath: string) => Promise<void>;
    };
  } {
    const files: { [path: string]: string } = {};
    return {
      files,
      adapter: {
        append: (path, data) => {
          files[path] = `${files[path] ?? ""}${data}`;
          return Promise.resolve();
        },
        read: (path) => Promise.resolve(files[path] ?? ""),
        rename: (fromPath, toPath) => {
          files[toPath] = files[fromPath] ?? "";
          files[fromPath] = "";
          return Promise.resolve();
        },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("leaves a line naming itemId, status, and byte count when a download fails", async () => {
    const { LOG_PATH } = await import("./log.js");
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });

    global.fetch = vi.fn((url) => {
      if (typeof url === "string" && url.startsWith("https://api.petroglyph.page/files")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              files: [
                {
                  itemId: "item-1",
                  name: "note.pdf",
                  relativePath: "",
                  mimeType: "application/pdf",
                  s3PresignedUrl:
                    "https://petroglyph.blob.core.windows.net/files/note.pdf?sig=capability-secret",
                  createdAt: "2026-04-11T10:00:00Z",
                },
              ],
              nextToken: null,
            }),
        });
      }
      return Promise.resolve({ ok: false, status: 403 });
    }) as unknown as typeof fetch;

    const files: { [path: string]: string } = {};
    const adapter = {
      exists: vi.fn(() => Promise.resolve(true)),
      mkdir: vi.fn(() => Promise.resolve()),
      readBinary: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
      writeBinary: vi.fn(() => Promise.resolve()),
      write: vi.fn(() => Promise.resolve()),
      append: (path: string, data: string) => {
        files[path] = `${files[path] ?? ""}${data}`;
        return Promise.resolve();
      },
      read: (path: string) => Promise.resolve(files[path] ?? ""),
      rename: (fromPath: string, toPath: string) => {
        files[toPath] = files[fromPath] ?? "";
        files[fromPath] = "";
        return Promise.resolve();
      },
    };
    // @ts-expect-error — minimal stub
    plugin.app = { vault: { adapter } };

    await plugin.performSync();

    const written = files[LOG_PATH] ?? "";
    expect(written).toContain("ERROR download download failed");
    expect(written).toContain("itemId=item-1");
    expect(written).toContain("status=403");
    expect(written).toContain("bytes=0");
    expect(written).not.toContain("capability-secret");
  });

  it("logs the startup state a fresh session needs", async () => {
    const { LOG_PATH } = await import("./log.js");
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());

    const { plugin } = await makePlugin({
      apiBaseUrl: "https://api.example.com",
      jwt: "jwt-token",
      oneDriveConnected: true,
      oneDriveStatus: "connected",
      activeProfileId: "profile-2",
      feedCursors: { "profile-2": "cursor-1" },
    });

    const files: { [path: string]: string } = {};
    const adapter = {
      append: (path: string, data: string) => {
        files[path] = `${files[path] ?? ""}${data}`;
        return Promise.resolve();
      },
      read: (path: string) => Promise.resolve(files[path] ?? ""),
      rename: () => Promise.resolve(),
    };
    // @ts-expect-error — minimal stub
    plugin.app = { vault: { adapter } };

    await plugin.onload();

    const written = files[LOG_PATH] ?? "";
    expect(written).toContain("INFO startup plugin loaded");
    expect(written).toContain("apiBaseUrl=https://api.example.com");
    expect(written).toContain("activeProfileId=profile-2");
    expect(written).toContain("oneDriveStatus=connected");
    expect(written).toContain("cursors=1");
    expect(written).not.toContain("jwt-token");
  });
  it("logs why a token refresh could not reach the API", async () => {
    const { LOG_PATH } = await import("./log.js");
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
    const { files, adapter } = createLogSink();
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      refreshToken: "refresh-token",
      username: "alice",
    });
    // @ts-expect-error — minimal stub
    plugin.app = { vault: { adapter } };
    global.fetch = vi.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    await plugin.onload();
    await plugin.performRefresh();
    await vi.advanceTimersByTimeAsync(2000);
    const written = files[LOG_PATH] ?? "";
    expect(written).toContain("WARN auth refresh failed");
    expect(written).toContain("error=Error: offline");
  });
  it("logs a token refresh the API rejected", async () => {
    const { LOG_PATH } = await import("./log.js");
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
    const { files, adapter } = createLogSink();
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      refreshToken: "refresh-token",
      username: "alice",
    });
    // @ts-expect-error — minimal stub
    plugin.app = { vault: { adapter } };
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: 401 }),
    ) as unknown as typeof fetch;
    await plugin.onload();
    await plugin.performRefresh();
    await vi.advanceTimersByTimeAsync(2000);
    const written = files[LOG_PATH] ?? "";
    expect(written).toContain("WARN auth refresh rejected");
    expect(written).toContain("status=401");
  });
  it("logs an auth callback that carried no credentials", async () => {
    const { LOG_PATH } = await import("./log.js");
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
    const { files, adapter } = createLogSink();
    const { plugin } = await makePlugin();
    // @ts-expect-error — minimal stub
    plugin.app = { vault: { adapter } };
    await plugin.onload();
    const registerProtocolHandler = plugin.registerObsidianProtocolHandler; // eslint-disable-line @typescript-eslint/unbound-method
    const handler = vi
      .mocked(registerProtocolHandler)
      .mock.calls.find((call) => call[0] === "petroglyph/auth/callback")?.[1];
    await handler?.({ action: "callback", jwt: "jwt-token", username: "alice" });
    await vi.advanceTimersByTimeAsync(2000);
    const written = files[LOG_PATH] ?? "";
    expect(written).toContain("ERROR auth login failed");
    expect(written).toContain("reason=missing auth params");
  });
  it("logs a OneDrive connection the API rejected", async () => {
    const { LOG_PATH } = await import("./log.js");
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
    const { files, adapter } = createLogSink();
    const { plugin } = await makePlugin({ jwt: "jwt-token" });
    // @ts-expect-error — minimal stub
    plugin.app = { vault: { adapter } };
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: 502 }),
    ) as unknown as typeof fetch;
    await plugin.onload();
    await plugin.handleOneDriveCallback({ code: "code-1", state: "state-1" });
    await vi.advanceTimersByTimeAsync(2000);
    const written = files[LOG_PATH] ?? "";
    expect(written).toContain("ERROR auth onedrive connect failed");
    expect(written).toContain("status=502");
  });
});

describe("version reconciliation", () => {
  const OLD_VERSION = '"{00000000-0000-0000-0000-000000000001},21"';
  const NEW_VERSION = '"{00000000-0000-0000-0000-000000000001},22"';
  const OLD_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const NEW_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", makeWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Answers `/files` with one page, and every other URL with PDF bytes. */
  function feedThenBytes(options: {
    files: FeedEntry[];
    bytes: Uint8Array;
    downloads: string[];
  }): typeof fetch {
    return vi.fn((url) => {
      if (typeof url === "string" && url.includes("/files")) {
        return Promise.resolve(jsonResponse({ files: options.files, nextToken: null }));
      }
      options.downloads.push(String(url));
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(options.bytes.buffer),
      } as unknown as Response);
    }) as unknown as typeof fetch;
  }

  it("skips an item whose version the vault already holds, and never downloads it", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      feedEtags: { default: { "item-1": OLD_VERSION } },
    });
    const vault = makeVaultStub();
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    const downloads: string[] = [];
    global.fetch = feedThenBytes({
      files: [makeFeedEntry({ eTag: OLD_VERSION })],
      bytes: OLD_BYTES,
      downloads,
    });

    await plugin.performSync();

    expect(downloads).toEqual([]);
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
    expect(vault.adapter.write).not.toHaveBeenCalled();
  });

  it("writes an item the vault holds no version for, and records the version", async () => {
    const { plugin } = await makePlugin({ jwt: "jwt-token", oneDriveConnected: true });
    const vault = makeVaultStub();
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    const downloads: string[] = [];
    global.fetch = feedThenBytes({
      files: [makeFeedEntry({ eTag: NEW_VERSION })],
      bytes: NEW_BYTES,
      downloads,
    });

    await plugin.performSync();

    expect(downloads).toEqual(["https://s3.example.com/file.pdf"]);
    expect(vault.adapter.writeBinary).toHaveBeenCalledWith("handwritten/note.pdf", NEW_BYTES);
    expect(plugin.data.feedEtags?.["default"]?.["item-1"]).toBe(NEW_VERSION);
  });

  it("rewrites the vault file when the version changed and the bytes differ", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      feedEtags: { default: { "item-1": OLD_VERSION } },
    });
    const vault = makeVaultStub();
    vault.adapter.readBinary.mockResolvedValue(OLD_BYTES.buffer);
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    const downloads: string[] = [];
    global.fetch = feedThenBytes({
      files: [makeFeedEntry({ eTag: NEW_VERSION })],
      bytes: NEW_BYTES,
      downloads,
    });

    await plugin.performSync();

    expect(vault.adapter.writeBinary).toHaveBeenCalledWith("handwritten/note.pdf", NEW_BYTES);
    expect(plugin.data.feedEtags?.["default"]?.["item-1"]).toBe(NEW_VERSION);
  });

  it("does not rewrite when a changed version carries the same bytes, but records the version", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      feedEtags: { default: { "item-1": OLD_VERSION } },
    });
    const vault = makeVaultStub();
    vault.adapter.readBinary.mockResolvedValue(NEW_BYTES.buffer);
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    const downloads: string[] = [];
    global.fetch = feedThenBytes({
      files: [makeFeedEntry({ eTag: NEW_VERSION })],
      bytes: NEW_BYTES,
      downloads,
    });

    await plugin.performSync();

    expect(downloads).toHaveLength(1);
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
    expect(plugin.data.feedEtags?.["default"]?.["item-1"]).toBe(NEW_VERSION);
  });

  it("downloads and byte-compares when the feed carries no version", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      feedEtags: { default: { "item-1": OLD_VERSION } },
    });
    const vault = makeVaultStub();
    vault.adapter.readBinary.mockResolvedValue(OLD_BYTES.buffer);
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    const downloads: string[] = [];
    global.fetch = feedThenBytes({
      files: [makeFeedEntry({})],
      bytes: OLD_BYTES,
      downloads,
    });

    await plugin.performSync();

    expect(downloads).toHaveLength(1);
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("rewrites an item that sorts below the cursor the previous drain reached", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      feedEtags: { default: { "item-a": OLD_VERSION } },
    });
    const vault = makeVaultStub();
    vault.adapter.readBinary.mockResolvedValue(OLD_BYTES.buffer);
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    let version = OLD_VERSION;
    const requested: string[] = [];
    global.fetch = vi.fn((url) => {
      if (typeof url !== "string" || !url.includes("/files")) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(NEW_BYTES.buffer),
        } as unknown as Response);
      }
      requested.push(url);
      // The feed is itemId-ordered: a cursor naming the last item served can
      // never be followed by an item that sorts below it.
      const afterCursor = new URL(url).searchParams.get("nextToken");
      if (afterCursor !== null) {
        return Promise.resolve(jsonResponse({ files: [], nextToken: null }));
      }
      return Promise.resolve(
        jsonResponse({
          files: [makeFeedEntry({ itemId: "item-a", eTag: version })],
          nextToken: "item-z",
        }),
      );
    }) as unknown as typeof fetch;

    // First drain: the vault already holds item-a's version, so nothing is read.
    await plugin.performSync();
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
    expect(requested).toEqual([
      "https://api.petroglyph.page/files",
      "https://api.petroglyph.page/files?nextToken=item-z",
    ]);

    // Re-upload: same itemId, new version. The feed serves it from the head,
    // below the cursor the first drain reached.
    version = NEW_VERSION;
    requested.length = 0;
    await plugin.performSync();

    expect(vault.adapter.writeBinary).toHaveBeenCalledWith("handwritten/note.pdf", NEW_BYTES);
    expect(plugin.data.feedEtags?.["default"]?.["item-a"]).toBe(NEW_VERSION);
  });

  it("keeps only the versions the completed drain was served", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      feedEtags: { default: { "item-1": OLD_VERSION, "item-gone": OLD_VERSION } },
    });
    const vault = makeVaultStub();
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    const downloads: string[] = [];
    global.fetch = feedThenBytes({
      files: [makeFeedEntry({ eTag: OLD_VERSION })],
      bytes: OLD_BYTES,
      downloads,
    });

    await plugin.performSync();

    expect(plugin.data.feedEtags?.["default"]).toEqual({ "item-1": OLD_VERSION });
  });

  it("forgets the recorded versions on Reset Plugin State, so the next drain compares bytes again", async () => {
    const { plugin } = await makePlugin({
      jwt: "jwt-token",
      oneDriveConnected: true,
      feedEtags: { default: { "item-1": OLD_VERSION } },
    });
    await plugin.resetPluginState();

    expect(plugin.data.feedEtags?.["default"]).toBeUndefined();

    const vault = makeVaultStub();
    vault.adapter.readBinary.mockResolvedValue(OLD_BYTES.buffer);
    // @ts-expect-error — minimal stub
    plugin.app = { vault };
    const downloads: string[] = [];
    global.fetch = feedThenBytes({
      files: [makeFeedEntry({ eTag: OLD_VERSION })],
      bytes: OLD_BYTES,
      downloads,
    });

    await plugin.performSync();

    expect(downloads).toHaveLength(1);
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
  });
});

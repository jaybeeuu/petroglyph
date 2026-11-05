import { describe, expect, it, vi } from "vitest";
import {
  LOG_PATH,
  PluginLog,
  appLogSink,
  describeError,
  logAbsolutePath,
  revealInOs,
} from "./log.js";
import type { LogSink } from "./log.js";

interface MemorySink {
  sink: LogSink;
  appends: string[];
  renames: { fromPath: string; toPath: string }[];
  files: { [path: string]: string };
}

function createMemorySink(initialFiles: { [path: string]: string } = {}): MemorySink {
  const files: { [path: string]: string } = { ...initialFiles };
  const appends: string[] = [];
  const renames: { fromPath: string; toPath: string }[] = [];
  const sink: LogSink = {
    append: (path, data) => {
      appends.push(data);
      files[path] = `${files[path] ?? ""}${data}`;
      return Promise.resolve();
    },
    read: (path) => Promise.resolve(files[path] ?? ""),
    rename: (fromPath, toPath) => {
      renames.push({ fromPath, toPath });
      files[toPath] = files[fromPath] ?? "";
      files[fromPath] = "";
      return Promise.resolve();
    },
  };
  return { sink, appends, renames, files };
}

describe("PluginLog", () => {
  it("writes one timestamped line per entry when flushed", async () => {
    const memory = createMemorySink();
    const log = new PluginLog({
      sink: () => memory.sink,
      now: () => new Date("2026-05-01T10:00:00.000Z"),
    });

    log.warn("vault", "skipped identical file", { path: "handwritten/note.pdf" });
    await log.flush();

    expect(memory.files[LOG_PATH]).toBe(
      "2026-05-01T10:00:00.000Z WARN vault skipped identical file path=handwritten/note.pdf\n",
    );
  });

  it("keeps the query string of a presigned URL out of the log", async () => {
    const memory = createMemorySink();
    const log = new PluginLog({ sink: () => memory.sink });

    log.error("download", "download failed", {
      itemId: "item-1",
      url: "https://petroglyph.blob.core.windows.net/files/note.pdf?sv=2024-01-01&sig=sas-capability-secret&se=2026-01-01",
      status: 403,
      bytes: 0,
    });
    await log.flush();

    const written = memory.files[LOG_PATH] ?? "";
    expect(written).toContain("url=https://petroglyph.blob.core.windows.net/files/note.pdf");
    expect(written).not.toContain("sig=");
    expect(written).not.toContain("sas-capability-secret");
  });

  it("refuses to emit a value stored under a sensitive key", async () => {
    const memory = createMemorySink();
    const log = new PluginLog({ sink: () => memory.sink });

    log.info("auth", "credentials refreshed", {
      jwt: "header.payload.signature",
      refreshToken: "refresh-secret",
      authorization: "Bearer access-secret",
      sas: "sv=2024-01-01&sig=sas-secret",
    });
    await log.flush();

    const written = memory.files[LOG_PATH] ?? "";
    expect(written).toContain("jwt=[redacted]");
    expect(written).toContain("refreshToken=[redacted]");
    expect(written).not.toContain("refresh-secret");
    expect(written).not.toContain("access-secret");
    expect(written).not.toContain("sas-secret");
  });

  it("keeps a field whose key only resembles a credential", async () => {
    const memory = createMemorySink();
    const log = new PluginLog({ sink: () => memory.sink });

    log.info("feed", "page", { files: 2, nextCursor: "page-2-cursor" });
    await log.flush();

    expect(memory.files[LOG_PATH]).toContain("nextCursor=page-2-cursor");
  });

  it("coalesces a burst of entries into one append", async () => {
    const memory = createMemorySink();
    const log = new PluginLog({ sink: () => memory.sink });

    for (let index = 0; index < 48; index += 1) {
      log.info("vault", "wrote", { path: `handwritten/${index}.pdf` });
    }
    await log.flush();

    expect(memory.appends).toHaveLength(1);
    expect((memory.files[LOG_PATH] ?? "").trimEnd().split("\n")).toHaveLength(48);
  });

  it("drops the oldest entries once the buffer is full", async () => {
    const memory = createMemorySink();
    const log = new PluginLog({ sink: () => memory.sink, maxEntries: 2 });

    log.info("feed", "first");
    log.info("feed", "second");
    log.info("feed", "third");
    await log.flush();

    const lines = (memory.files[LOG_PATH] ?? "").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(memory.files[LOG_PATH]).not.toContain("first");
  });

  it("rotates to a numbered file when the next flush would pass the cap", async () => {
    const memory = createMemorySink({ [LOG_PATH]: "x".repeat(190) });
    const log = new PluginLog({ sink: () => memory.sink, rotateBytes: 200 });

    log.info("vault", "wrote", { path: "handwritten/note.pdf" });
    await log.flush();

    expect(memory.renames).toEqual([{ fromPath: LOG_PATH, toPath: `${LOG_PATH}.1` }]);
    expect(memory.files[`${LOG_PATH}.1`]).toBe("x".repeat(190));
    expect(memory.files[LOG_PATH]).toContain("handwritten/note.pdf");
    expect((memory.files[LOG_PATH] ?? "").length).toBeLessThanOrEqual(200);
  });

  it("keeps writing to one file until the cap is reached", async () => {
    const memory = createMemorySink();
    const log = new PluginLog({ sink: () => memory.sink, rotateBytes: 100_000 });

    log.info("vault", "wrote", { path: "handwritten/a.pdf" });
    log.info("vault", "wrote", { path: "handwritten/b.pdf" });
    await log.flush();
    await log.flush();

    expect(memory.renames).toHaveLength(0);
    expect((memory.files[LOG_PATH] ?? "").trimEnd().split("\n")).toHaveLength(2);
  });

  it("survives a sink that cannot write", async () => {
    const log = new PluginLog({
      sink: () => ({
        append: () => Promise.reject(new Error("disk full")),
        read: () => Promise.reject(new Error("no file")),
        rename: () => Promise.reject(new Error("no file")),
      }),
    });

    log.error("download", "download failed", { itemId: "item-1", status: 403, bytes: 0 });

    await expect(log.flush()).resolves.toBeUndefined();
  });

  it("buffers without a sink and returns the buffer from contents", async () => {
    const log = new PluginLog({ sink: () => undefined });

    log.info("feed", "requested", { url: "https://api.example.com/files?after=cursor-1" });

    const contents = await log.contents();
    expect(contents).toContain("url=https://api.example.com/files");
    expect(contents).not.toContain("cursor-1");
  });

  it("returns the flushed file followed by buffered lines from contents", async () => {
    const memory = createMemorySink({ [LOG_PATH]: "written line\n" });
    const log = new PluginLog({ sink: () => memory.sink });

    log.info("feed", "buffered line");

    const contents = await log.contents();
    expect(contents.startsWith("written line\n")).toBe(true);
    expect(contents).toContain("INFO feed buffered line");
  });
});

describe("appLogSink", () => {
  it("returns undefined when the app has no vault adapter file operations", () => {
    expect(appLogSink(undefined)).toBeUndefined();
    expect(appLogSink({})).toBeUndefined();
    expect(
      appLogSink({ vault: { adapter: { exists: () => Promise.resolve(true) } } }),
    ).toBeUndefined();
  });

  it("writes through the vault adapter", async () => {
    const files: { [path: string]: string } = {};
    const adapter = {
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
    const log = new PluginLog({ sink: () => appLogSink({ vault: { adapter } }) });

    log.info("startup", "plugin loaded", { version: "0.0.0" });
    await log.flush();

    expect(files[LOG_PATH]).toContain("startup plugin loaded version=0.0.0");
  });
});

describe("logAbsolutePath", () => {
  it("resolves the absolute path through a desktop adapter", () => {
    const adapter = {
      getFullPath: (path: string) => `/home/alice/vault/${path}`,
    };

    expect(logAbsolutePath(adapter, LOG_PATH)).toBe(`/home/alice/vault/${LOG_PATH}`);
  });

  it("returns undefined when the adapter has no absolute path", () => {
    expect(logAbsolutePath({ append: () => Promise.resolve() }, LOG_PATH)).toBeUndefined();
  });
});

describe("revealInOs", () => {
  it("reveals the file through the Electron shell", () => {
    const showItemInFolder = vi.fn();
    vi.stubGlobal(
      "require",
      vi.fn(() => ({ shell: { showItemInFolder } })),
    );

    const revealed = revealInOs("/home/alice/vault/.obsidian/plugins/petroglyph/petroglyph.log");

    expect(revealed).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith(
      "/home/alice/vault/.obsidian/plugins/petroglyph/petroglyph.log",
    );
    vi.unstubAllGlobals();
  });

  it("reports failure when the renderer exposes no Electron shell", () => {
    vi.stubGlobal("require", undefined);

    expect(revealInOs("/tmp/petroglyph.log")).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("describeError", () => {
  it("names the error type and message", () => {
    expect(describeError(new TypeError("offline"))).toBe("TypeError: offline");
  });

  it("describes a thrown non-error", () => {
    expect(describeError("boom")).toBe("boom");
  });
});

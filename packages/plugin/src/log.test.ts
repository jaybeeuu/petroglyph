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

/** The text the log flushed after `record` wrote its lines. */
async function flushedText(record: (log: PluginLog) => void): Promise<string> {
  const memory = createMemorySink();
  const log = new PluginLog({ sink: () => memory.sink });
  record(log);
  await log.flush();
  return memory.files[LOG_PATH] ?? "";
}

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc";
const HEX_TOKEN = "a3f5c9d1b2e4f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d";

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

  it("keeps only the host and path of a presigned download URL", async () => {
    const written = await flushedText((log) => {
      log.error("download", "download failed", {
        itemId: "item-1",
        url: "https://petroglyph.blob.core.windows.net/files/note.pdf?sv=2024-01-01&sig=capability-secret&se=2026-01-01",
        status: 403,
        bytes: 0,
      });
    });

    expect(written).toContain("url=https://petroglyph.blob.core.windows.net/files/note.pdf");
    expect(written).not.toContain("sig=capability-secret");
  });

  it("keeps the query off a presigned URL whose scheme is uppercase", async () => {
    const written = await flushedText((log) => {
      log.error("download", "download failed", {
        url: "HTTPS://petroglyph.blob.core.windows.net/files/note.pdf?sig=capability-secret",
      });
    });

    expect(written).toContain("url=HTTPS://petroglyph.blob.core.windows.net/files/note.pdf");
    expect(written).not.toContain("capability-secret");
  });

  it("keeps the query off a protocol-relative presigned URL", async () => {
    const written = await flushedText((log) => {
      log.error("download", "download failed", {
        url: "//petroglyph.blob.core.windows.net/files/note.pdf?sig=capability-secret",
      });
    });

    expect(written).toContain("url=//petroglyph.blob.core.windows.net/files/note.pdf");
    expect(written).not.toContain("capability-secret");
  });

  it("keeps the query off a scheme-less presigned URL", async () => {
    const written = await flushedText((log) => {
      log.error("download", "download failed", {
        url: "petroglyph.blob.core.windows.net/files/note.pdf?sig=capability-secret",
      });
    });

    expect(written).toContain("url=petroglyph.blob.core.windows.net/files/note.pdf");
    expect(written).not.toContain("capability-secret");
  });

  it("keeps the query off a local presigned URL that names a port", async () => {
    const written = await flushedText((log) => {
      log.error("download", "download failed", {
        url: "http://127.0.0.1:4566/petroglyph/note.pdf?X-Amz-Signature=capability-secret",
      });
    });

    expect(written).toContain("url=http://127.0.0.1:4566/petroglyph/note.pdf");
    expect(written).not.toContain("capability-secret");
  });

  it("keeps the query out of a URL embedded in a message", async () => {
    const written = await flushedText((log) => {
      log.error(
        "download",
        "GET https://petroglyph.blob.core.windows.net/files/note.pdf?sig=capability-secret returned 403",
      );
    });

    expect(written).toContain(
      "GET https://petroglyph.blob.core.windows.net/files/note.pdf returned 403",
    );
    expect(written).not.toContain("capability-secret");
  });

  it("keeps a plain question mark in a message", async () => {
    const written = await flushedText((log) => {
      log.warn("vault", "retry the write? the disk was full");
    });

    expect(written).toContain("retry the write? the disk was full");
  });

  it("keeps the punctuation of prose in a message", async () => {
    const written = await flushedText((log) => {
      log.warn("vault", "download failed; see issue#12 then retry the write?");
    });

    expect(written).toContain("download failed; see issue#12 then retry the write?");
  });

  it("keeps a semicolon in a vault path", async () => {
    const written = await flushedText((log) => {
      log.info("vault", "wrote", { path: "handwritten/a;b.pdf" });
    });

    expect(written).toContain("path=handwritten/a;b.pdf");
  });

  it("writes a redacted value for every key the allow-list does not declare", async () => {
    const memory = createMemorySink();
    const log = new PluginLog({ sink: () => memory.sink });

    log.info("auth", "credentials refreshed", {
      jwt: "header.payload.signature",
      refreshToken: "refresh-secret",
      authorization: "Bearer access-secret",
      sas: "sv=2024-01-01&sig=sas-secret",
      header: "Bearer header-secret",
      cookie: "session=cookie-secret",
      note: "plain word",
    });
    await log.flush();

    const written = memory.files[LOG_PATH] ?? "";
    for (const key of ["jwt", "refreshToken", "authorization", "sas", "header", "cookie", "note"]) {
      expect(written).toContain(`${key}=[redacted]`);
    }
    expect(written).not.toContain("refresh-secret");
    expect(written).not.toContain("access-secret");
    expect(written).not.toContain("sas-secret");
    expect(written).not.toContain("header-secret");
    expect(written).not.toContain("cookie-secret");
    expect(written).not.toContain("plain word");
  });

  it("logs a feed cursor named nextToken and a resetToken boolean", async () => {
    const memory = createMemorySink();
    const log = new PluginLog({ sink: () => memory.sink });

    log.info("feed", "page", { files: 2, nextToken: "page-2-cursor" });
    log.info("profile", "reset", { resetToken: true });
    await log.flush();

    const written = memory.files[LOG_PATH] ?? "";
    expect(written).toContain("nextToken=page-2-cursor");
    expect(written).toContain("resetToken=true");
    expect(written).not.toContain("[redacted]");
  });

  it("keeps a newline in a message on the one line it belongs to", async () => {
    const memory = createMemorySink();
    const log = new PluginLog({ sink: () => memory.sink });

    log.error("download", "download threw", {
      error: "TypeError: socket hang up\nERROR download forged line",
    });
    await log.flush();

    expect((memory.files[LOG_PATH] ?? "").trimEnd().split("\n")).toHaveLength(1);
    expect(memory.files[LOG_PATH]).toContain(
      "error=TypeError: socket hang up ERROR download forged line",
    );
  });

  it("keeps the batch buffered when a write fails, so the next flush retries it", async () => {
    const files: { [path: string]: string } = {};
    let attempts = 0;
    const log = new PluginLog({
      sink: () => ({
        append: (path, data) => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("disk full"));
          files[path] = `${files[path] ?? ""}${data}`;
          return Promise.resolve();
        },
        read: (path) => Promise.resolve(files[path] ?? ""),
        rename: () => Promise.resolve(),
      }),
    });

    log.info("vault", "wrote", { path: "handwritten/note.pdf" });
    await log.flush();
    await log.flush();

    expect(files[LOG_PATH]).toContain("path=handwritten/note.pdf");
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

  it("keeps the batch when a flush runs before the sink exists", async () => {
    const memory = createMemorySink();
    let sinkAvailable = false;
    const log = new PluginLog({ sink: () => (sinkAvailable ? memory.sink : undefined) });

    log.info("vault", "wrote", { path: "handwritten/note.pdf" });
    await log.flush();
    const buffered = await log.contents();
    sinkAvailable = true;
    await log.flush();

    expect(buffered).toContain("path=handwritten/note.pdf");
    expect(memory.files[LOG_PATH]).toContain("path=handwritten/note.pdf");
  });

  it.each([
    {
      shape: "a JWT split across two fields",
      fields: { first: "eyJhbGciOiJIUzI1NiJ9.", second: "eyJzdWIiOiIxIn0.abc" },
      secret: "eyJzdWIiOiIxIn0",
    },
    {
      shape: "a presigned URL split across two fields",
      fields: { first: "https://bucket.s3.amazonaws.com/k.pdf", second: "?capability-secret" },
      secret: "capability-secret",
    },
    {
      shape: "a capability query alone",
      fields: { detail: "?capability-secret" },
      secret: "capability-secret",
    },
    {
      shape: "a capability query after a word",
      fields: { detail: "sig?capability-secret" },
      secret: "capability-secret",
    },
    { shape: "a lowercase hex token", fields: { note: HEX_TOKEN }, secret: HEX_TOKEN },
    {
      shape: "a bare token word",
      fields: { note: "EwCoA8thisIsAnAccessTokenValue" },
      secret: "EwCoA8thisIsAnAccessTokenValue",
    },
    {
      shape: "a Basic credential named in the value",
      fields: { note: "Authorization=Basic dXNlcjpwYXNzd29yZA==" },
      secret: "dXNlcjpwYXNzd29yZA==",
    },
    {
      shape: "a short base64 Basic credential",
      fields: { note: "dXNlcjpwYXNz" },
      secret: "dXNlcjpwYXNz",
    },
    {
      shape: "a JWT with a key id segment",
      fields: { value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aaa.bbb.ccc" },
      secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aaa.bbb.ccc",
    },
  ])(
    "writes nothing of $shape under a key the allow-list does not declare",
    async ({ fields, secret }) => {
      const written = await flushedText((log) => {
        log.error("auth", "state", fields);
      });

      expect(written).toContain("[redacted]");
      expect(written).not.toContain(secret);
    },
  );

  it.each([
    {
      shape: "a bearer token after a header name",
      message: "sent Authorization: Bearer bearer-in-message",
      secret: "bearer-in-message",
    },
    {
      shape: "a bearer token after an equals sign",
      message: "sending Authorization=Basic dXNlcjpwYXNzd29yZA==",
      secret: "dXNlcjpwYXNzd29yZA==",
    },
    { shape: "a JWT", message: `jwt is ${JWT}`, secret: JWT },
    {
      shape: "a header and a scheme in one word",
      message: "sent Authorization:Basic joined-secret",
      secret: "joined-secret",
    },
    {
      shape: "a scheme after an equals sign",
      message: "sent key=Bearer equals-secret",
      secret: "equals-secret",
    },
    { shape: "half a JWT", message: "part eyJzdWIiOiIxIn0.abc", secret: "eyJzdWIiOiIxIn0" },
    {
      shape: "a bare token word",
      message: "graph call failed with EwCoA8thisIsAnAccessTokenValue",
      secret: "EwCoA8thisIsAnAccessTokenValue",
    },
    {
      shape: "a short base64 Basic credential",
      message: "the server sent dXNlcjpwYXNz back",
      secret: "dXNlcjpwYXNz",
    },
    { shape: "a lowercase hex token", message: `token ${HEX_TOKEN}`, secret: HEX_TOKEN },
    {
      shape: "a cookie pair",
      message: "set cookie session=msg-cookie-secret",
      secret: "msg-cookie-secret",
    },
    {
      shape: "an opaque encoded blob",
      message: "got AbCdEf0123456789AbCdEf0123456789Zz",
      secret: "AbCdEf0123456789AbCdEf0123456789Zz",
    },
    {
      shape: "a bare capability query",
      message: "got ?capability-secret from the server",
      secret: "capability-secret",
    },
    {
      shape: "a capability query after a word",
      message: "got sig?capability-secret from the server",
      secret: "capability-secret",
    },
    {
      shape: "a semicolon parameter",
      message: "GET https://host.example.com/k.pdf;x=capability-secret",
      secret: "capability-secret",
    },
    {
      shape: "a double-encoded query",
      message: "GET https://host.example.com/k.pdf%253Fsig=capability-secret",
      secret: "capability-secret",
    },
  ])("keeps $shape out of the message", async ({ message, secret }) => {
    const written = await flushedText((log) => {
      log.error("auth", message);
    });

    expect(written).toContain("ERROR auth");
    expect(written).not.toContain(secret);
  });

  it.each([
    "//host.example.com/a.pdf?X-Custom-Thing=capability-secret",
    "host.example.com/a.pdf?X-Custom-Thing=capability-secret",
    "a.pdf?Policy=capability-secret",
    "https://host.example.com/a.pdf%3Fsig=capability-secret",
    "https://host.example.com/a.pdf#capability-secret",
  ])("strips the query of a URL value whatever its parameters: %s", async (url) => {
    const written = await flushedText((log) => {
      log.error("download", "download failed", { url });
    });

    expect(written).not.toContain("capability-secret");
    expect(written).toContain("url=");
  });

  it.each(["url", "path", "apiBaseUrl"])(
    "strips the query of a location-shaped value written under %s",
    async (key) => {
      const written = await flushedText((log) => {
        log.error("download", "download failed", {
          [key]: "https://host.example.com/a.pdf?sig=capability-secret",
        });
      });

      expect(written).not.toContain("capability-secret");
      expect(written).toContain(`${key}=https://host.example.com/a.pdf`);
    },
  );

  it.each([
    "https://host.example.com/a.pdf;x=capability-secret",
    "https://host.example.com/a.pdf%253Fsig=capability-secret",
    "https://host.example.com/a.pdf%3Fsig=capability-secret",
    "https://host.example.com/a.pdf#capability-secret",
    ";capability-secret",
  ])("strips a location tail whatever its shape: %s", async (url) => {
    const written = await flushedText((log) => {
      log.error("download", "download failed", { url });
    });

    expect(written).not.toContain("capability-secret");
    expect(written).toContain("url=");
  });

  it.each([
    "https://host.example.com/a.pdf?X-Custom=capability-secret",
    "a.pdf?Policy=capability-secret",
    "https://host.example.com/a.pdf%3FPolicy=capability-secret",
  ])("redacts a location-shaped value under an undeclared key: %s", async (value) => {
    const written = await flushedText((log) => {
      log.error("download", "download failed", { detail: value });
    });

    expect(written).not.toContain("capability-secret");
    expect(written).toContain("detail=[redacted]");
  });

  it("keeps counters, cursors, ids and plain prose readable", async () => {
    const written = await flushedText((log) => {
      log.info("feed", "page", { files: 2, nextToken: "page-2-cursor", resetToken: true });
      log.error("download", "download failed", {
        itemId: "item-1",
        status: 403,
        bytes: 0,
        elapsedMs: 63,
      });
      log.warn("vault", "retry the write? the disk was full");
    });

    expect(written).toContain("nextToken=page-2-cursor");
    expect(written).toContain("resetToken=true");
    expect(written).toContain("itemId=item-1");
    expect(written).toContain("status=403");
    expect(written).toContain("bytes=0");
    expect(written).toContain("elapsedMs=63");
    expect(written).toContain("retry the write? the disk was full");
    expect(written).not.toContain("[redacted]");
  });

  it("keeps a long uppercase item id readable", async () => {
    const written = await flushedText((log) => {
      log.info("download", "downloaded", { itemId: "01ABCDEF0123456789ABCDEF0123456789AB" });
    });

    expect(written).toContain("itemId=01ABCDEF0123456789ABCDEF0123456789AB");
  });

  it("keeps a GUID item id readable", async () => {
    const written = await flushedText((log) => {
      log.info("download", "downloaded", { itemId: "a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6" });
    });

    expect(written).toContain("itemId=a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6");
  });

  it("keeps a long vault path readable", async () => {
    const written = await flushedText((log) => {
      log.info("vault", "wrote", { path: "handwritten/2024/scans/ScanOfReceipt-2024-11-05.pdf" });
    });

    expect(written).toContain("path=handwritten/2024/scans/ScanOfReceipt-2024-11-05.pdf");
    expect(written).not.toContain("[redacted]");
  });

  it("keeps a feed cursor readable when its own shape is an encoded cursor", async () => {
    const nextToken =
      "eyJmaWxlSWQiOiJhYmMxMjMiLCJjcmVhdGVkQXQiOiIyMDI0LTExLTA1VDEwOjAwOjAwLjAwMFoifQ";
    const written = await flushedText((log) => {
      log.info("feed", "page", { files: 2, nextToken });
    });

    expect(written).toContain(`nextToken=${nextToken}`);
  });

  it("replaces a credential that appears inside an allow-listed error value", async () => {
    const written = await flushedText((log) => {
      log.error("download", "download threw", { error: `TypeError: rejected ${JWT}` });
    });

    expect(written).toContain("error=TypeError: rejected [redacted]");
    expect(written).not.toContain(JWT);
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

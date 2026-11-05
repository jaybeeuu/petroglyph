import { isRecord } from "./validate.js";

/** Where the plugin writes its diagnostics log, relative to the vault root. */
export const LOG_PATH = ".obsidian/plugins/petroglyph/petroglyph.log";

/** Entries held in memory between flushes; a whole feed of 48 files fits easily. */
export const MAX_BUFFERED_ENTRIES = 500;

/** Approximate size, in characters, at which the log rotates to `petroglyph.log.1`. */
export const ROTATE_BYTES = 256 * 1024;

/**
 * A field key whose value is a credential: the query string of a capability
 * URL, an access token, or a signing key. Such a value is never emitted. Any
 * key containing "token" is refused, so a caller must not name a feed cursor
 * `nextToken`; `nextCursor` carries the same value and is not a credential.
 */
const SENSITIVE_KEY = /(token|jwt|refresh|authorization|bearer|sas|signature|secret|password)/i;

/** Matches an absolute URL anywhere in a line, so its query can be stripped. */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/** The concern a log line belongs to. */
export type LogArea = "startup" | "auth" | "feed" | "download" | "vault" | "profile";

/** How much attention a line deserves. */
export type LogLevel = "info" | "warn" | "error";

/** One `key=value` field appended to a line. */
export type LogValue = string | number | boolean | null | undefined;

export type LogFields = { [key: string]: LogValue };

/** The vault adapter file operations the log needs. */
export interface LogSink {
  append(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  rename(fromPath: string, toPath: string): Promise<void>;
}

export interface PluginLogOptions {
  /** Resolved per flush, so the log can appear once the plugin has its vault. */
  sink?: () => LogSink | undefined;
  path?: string;
  now?: () => Date;
  maxEntries?: number;
  rotateBytes?: number;
}

/**
 * Replaces the query string of every URL in `text` with nothing, keeping the
 * scheme, host, and path. The query of a presigned URL is the capability, so it
 * must never reach the file.
 */
function stripUrlQueries(text: string): string {
  return text.replace(URL_PATTERN, (match) => {
    try {
      const url = new URL(match);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return match.split("?")[0] ?? match;
    }
  });
}

/**
 * A diagnosable text log the agent can read while the plugin runs. Lines are
 * buffered and written in one append per flush; the file rotates at a fixed
 * size so a long session cannot fill the disk. Redaction happens here, not at
 * the call sites, so a future caller cannot leak a credential by accident.
 */
export class PluginLog {
  readonly #sink: () => LogSink | undefined;
  readonly #path: string;
  readonly #now: () => Date;
  readonly #maxEntries: number;
  readonly #rotateBytes: number;
  #entries: string[] = [];
  #size: number | null = null;
  #flushing = false;

  constructor(options: PluginLogOptions = {}) {
    this.#sink = options.sink ?? ((): undefined => undefined);
    this.#path = options.path ?? LOG_PATH;
    this.#now = options.now ?? ((): Date => new Date());
    this.#maxEntries = options.maxEntries ?? MAX_BUFFERED_ENTRIES;
    this.#rotateBytes = options.rotateBytes ?? ROTATE_BYTES;
  }

  info(area: LogArea, message: string, fields?: LogFields): void {
    this.#record("info", area, message, fields);
  }

  warn(area: LogArea, message: string, fields?: LogFields): void {
    this.#record("warn", area, message, fields);
  }

  error(area: LogArea, message: string, fields?: LogFields): void {
    this.#record("error", area, message, fields);
  }

  /** Appends every buffered line in one write. A failed write never throws. */
  async flush(): Promise<void> {
    if (this.#flushing || this.#entries.length === 0) return;
    const lines = this.#entries;
    this.#entries = [];
    const sink = this.#sink();
    if (sink === undefined) return;

    this.#flushing = true;
    const text = `${lines.join("\n")}\n`;
    try {
      const size = this.#size ?? (await this.#currentSize(sink));
      if (size > 0 && size + text.length > this.#rotateBytes) {
        await sink.rename(this.#path, `${this.#path}.1`);
        await sink.append(this.#path, text);
        this.#size = text.length;
        return;
      }
      await sink.append(this.#path, text);
      this.#size = size + text.length;
    } catch {
      // A log write that fails must never break a sync.
    } finally {
      this.#flushing = false;
    }
  }

  /** The flushed file followed by the buffered lines, for "Copy diagnostics". */
  async contents(): Promise<string> {
    const pending = this.#entries.join("\n");
    const sink = this.#sink();
    if (sink === undefined) return pending;
    try {
      const written = await sink.read(this.#path);
      return pending === "" ? written : `${written}${pending}\n`;
    } catch {
      return pending;
    }
  }

  #record(level: LogLevel, area: LogArea, message: string, fields?: LogFields): void {
    const parts = [this.#now().toISOString(), level.toUpperCase(), area, message];
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (value === undefined) continue;
      parts.push(`${key}=${SENSITIVE_KEY.test(key) ? "[redacted]" : String(value)}`);
    }
    this.#entries.push(stripUrlQueries(parts.join(" ")));
    if (this.#entries.length > this.#maxEntries) this.#entries.shift();
  }

  async #currentSize(sink: LogSink): Promise<number> {
    try {
      return (await sink.read(this.#path)).length;
    } catch {
      return 0;
    }
  }
}

/**
 * The log sink backed by an Obsidian app's vault adapter, or undefined when the
 * adapter cannot append, read, and rename files. Adapter IO works on mobile.
 */
export function appLogSink(app: unknown): LogSink | undefined {
  const adapter = appVaultAdapter(app);
  if (!isRecord(adapter)) return undefined;
  const candidate = adapter as Partial<LogSink>;
  if (
    typeof candidate.append !== "function" ||
    typeof candidate.read !== "function" ||
    typeof candidate.rename !== "function"
  ) {
    return undefined;
  }
  return candidate as LogSink;
}

/** The app's vault adapter, or undefined when the plugin has no vault yet. */
export function appVaultAdapter(app: unknown): unknown {
  if (!isRecord(app) || !isRecord(app["vault"])) return undefined;
  return app["vault"]["adapter"];
}

/** The absolute path of `path` through a desktop adapter; undefined on mobile. */
export function logAbsolutePath(adapter: unknown, path: string): string | undefined {
  if (!isRecord(adapter)) return undefined;
  const candidate = adapter as { getFullPath?: (path: string) => string };
  if (typeof candidate.getFullPath !== "function") return undefined;
  const absolutePath = candidate.getFullPath(path);
  return typeof absolutePath === "string" ? absolutePath : undefined;
}

/** Reveals `absolutePath` in the OS file manager. False when no desktop shell exists. */
export function revealInOs(absolutePath: string): boolean {
  const electron = (globalThis as { require?: (id: string) => unknown }).require?.("electron");
  if (!isRecord(electron) || !isRecord(electron["shell"])) return false;
  const candidate = electron["shell"] as { showItemInFolder?: (path: string) => void };
  if (typeof candidate.showItemInFolder !== "function") return false;
  candidate.showItemInFolder(absolutePath);
  return true;
}

/** The error's name and message; a thrown non-error is described as its text. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

import { isRecord } from "./validate.js";

/** Where the plugin writes its diagnostics log, relative to the vault root. */
export const LOG_PATH = ".obsidian/plugins/petroglyph/petroglyph.log";

/** Entries held in memory between flushes; a whole feed of 48 files fits easily. */
export const MAX_BUFFERED_ENTRIES = 500;

/** Approximate size, in characters, at which the log rotates to `petroglyph.log.1`. */
export const ROTATE_BYTES = 256 * 1024;

/**
 * Field keys whose value is a credential. The list is explicit and matched on
 * the whole key, so a caller can log a feed cursor named `nextToken` and a
 * boolean named `resetToken` while `refreshToken` and `apiKey` stay refused.
 */
const CREDENTIAL_KEY = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "header",
  "headers",
  "idtoken",
  "jwt",
  "password",
  "passwd",
  "refreshtoken",
  "sas",
  "sastoken",
  "secret",
  "setcookie",
  "signature",
  "token",
  "xapikey",
]);

/** A credential dressed as an ordinary value: the scheme word gives it away. */
const CREDENTIAL_VALUE = /^\s*(basic|bearer|digest)\s+\S/i;

/**
 * Query and fragment parameter names that carry a capability, so a query is
 * stripped even when the text before it does not look like a URL.
 */
const CREDENTIAL_PARAMETER =
  /(?:^|[?&;#])(?:code|key|password|secret|se|sig|signature|sp|spr|sr|st|sv|skt|ske|sks|skv|skoid|sktid|token|access_token|refresh_token|x-amz-[a-z-]+|x-goog-[a-z-]+)=/i;

/** A URL scheme in any case; the capability URL need not be lowercase. */
const ANY_SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;

/** A host with a dot, a dotted quad, or `localhost`, with or without a port. */
const HOST_LIKE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$|^(?:\d{1,3}\.){3}\d{1,3}$|^localhost$/i;

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
 * True when the text before a query names a URL or a bare host. The scheme may
 * be absent, protocol-relative, or uppercase: a capability URL that the strict
 * `URL` parser rejects still has a query to strip.
 */
function isUrlLike(head: string): boolean {
  if (ANY_SCHEME.test(head)) return true;
  const authority = head.replace(/^\/+/, "");
  const hostPort = (authority.split("/")[0] ?? "").replace(/^[^@]*@/, "");
  return HOST_LIKE.test(hostPort.replace(/:\d+$/, ""));
}

/**
 * Drops the query or fragment of one whitespace-delimited token when it carries
 * a capability, keeping the scheme, host, and path. A miss would leak a
 * presigned signature, so a token that only looks like a URL is stripped too.
 */
function redactToken(token: string): string {
  const cut = token.search(/[?#]/);
  if (cut === -1) {
    const parameter = CREDENTIAL_PARAMETER.exec(token);
    return parameter === null ? token : token.slice(0, parameter.index);
  }
  const head = token.slice(0, cut);
  if (isUrlLike(head) || CREDENTIAL_PARAMETER.test(token.slice(cut))) return head;
  return token;
}

/**
 * Removes every query or fragment a credential could hide in, across a whole
 * line. The query of a presigned URL is the capability, so it never reaches the
 * file.
 */
function redactText(text: string): string {
  return text.replace(/\S+/g, redactToken);
}

/** Collapses line breaks so one entry cannot forge a second log line. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** True when `key` names a credential after removing punctuation and case. */
function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/**
 * A diagnosable text log the agent can read while the plugin runs. Lines are
 * buffered and written in one append per flush; the file rotates at a fixed
 * size so a long session cannot fill the disk. Redaction happens here, not at
 * the call sites: a credential key is replaced, and every query or fragment is
 * stripped from a value that looks like a URL. A caller cannot leak one by
 * accident.
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
      // A log write that fails must never break a sync. The batch stays buffered
      // so the next flush retries it, and the size is re-read from the file.
      this.#entries = [...lines, ...this.#entries].slice(-this.#maxEntries);
      this.#size = null;
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
    const parts = [this.#now().toISOString(), level.toUpperCase(), area, oneLine(message)];
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (value === undefined) continue;
      const text = oneLine(String(value));
      const refused = isCredentialKey(key) || CREDENTIAL_VALUE.test(text);
      parts.push(`${key}=${refused ? "[redacted]" : text}`);
    }
    this.#entries.push(redactText(parts.join(" ")));
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

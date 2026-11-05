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

/**
 * A field key that names a location, so whatever follows its path is the
 * capability. The key is matched, not the parameters, so a query is stripped
 * before any parameter name has to be recognised.
 */
const URL_KEY = /(url|uri|href|link|presign|signed)/i;

/** An HTTP auth scheme: the word after it is the credential, whatever its shape. */
const SCHEME_WORD = /^(?:basic|bearer|digest|negotiate|ntlm)$/i;

/** A header name that carries a credential in the word after it. */
const CREDENTIAL_HEADER =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|www-authenticate)$/i;

/**
 * The name of a `name=value` pair that marks the value as a credential. This
 * catches the shape on its own, without the field key or a parameter list.
 */
const CREDENTIAL_NAME =
  /(?:token|secret|password|passwd|passphrase|credential|cookie|session|auth|api[-_]?key|sig|signature|sas|private|nonce)/i;

/** A compact JWT or JWS: base64url of `{"` plus two more dot-separated segments. */
const JWT_SHAPE = /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+){2,}/;

/** Where a query or a fragment starts, literal or percent-encoded. */
const QUERY_MARKER = /[?#]|%3f|%23/i;

/** Text that only an encoded blob produces: long, mixed case, and mixed with digits. */
const OPAQUE_RUN = /[A-Za-z0-9+/_=~-]{32,}/g;

/** Written in place of a credential. */
const REDACTED = "[redacted]";

/** Punctuation that trails a word without belonging to it. */
const TRAILING_PUNCTUATION = /[),.;:!?\]}>"']+$/;

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

/** Where a query or a fragment starts, or -1 when the text has none. */
function queryStart(text: string): number {
  const marker = QUERY_MARKER.exec(text);
  return marker === null ? -1 : marker.index;
}

/** Drops the query and the fragment, keeping the scheme, host, and path. */
function stripQuery(text: string): string {
  const cut = queryStart(text);
  return cut === -1 ? text : text.slice(0, cut);
}

/**
 * True when the tail after a `?`, a `#`, or their encoded form is a query with
 * a parameter, rather than the punctuation of a sentence.
 */
function isQueryTail(tail: string): boolean {
  return /[?#&][^=&#\s]*=/.test(tail);
}

/** True when a token carries a `name=value` pair whose name marks a credential. */
function hasCredentialPair(token: string): boolean {
  for (const pair of token.matchAll(/(?:^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_.-]*)=/g)) {
    if (CREDENTIAL_NAME.test(pair[1] ?? "")) return true;
  }
  return false;
}

/** True when a token holds a long run that only an encoded secret produces. */
function isOpaque(token: string): boolean {
  for (const run of token.match(OPAQUE_RUN) ?? []) {
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)) return true;
  }
  return false;
}

/** Carried between two words: a scheme or a header name marks the next one. */
interface WordState {
  pending: boolean;
}

/**
 * Redacts one whitespace-delimited word of a value or of a message. The query
 * of a URL is dropped whatever its parameters; a credential shape is replaced.
 * A word with no credential shape survives, so `status=403` and a question mark
 * in prose still reach the file.
 */
function redactWord(word: string, state: WordState): string {
  const cut = queryStart(word);
  const head = cut === -1 ? word : word.slice(0, cut);
  const tail = cut === -1 ? "" : word.slice(cut);
  const kept = tail !== "" && !isUrlLike(head) && !isQueryTail(tail) ? word : head;
  const bare = head.replace(TRAILING_PUNCTUATION, "");

  if (state.pending && !SCHEME_WORD.test(bare)) {
    state.pending = false;
    return REDACTED;
  }
  if (SCHEME_WORD.test(bare) || CREDENTIAL_HEADER.test(bare)) {
    state.pending = true;
    return kept;
  }
  if (JWT_SHAPE.test(kept) || hasCredentialPair(kept) || isOpaque(kept)) return REDACTED;
  return kept;
}

/**
 * Redacts a value or a message word by word. Every check is structural, so a
 * credential under an unexpected key, or inside free text, is caught too.
 */
function redactWords(text: string): string {
  const state: WordState = { pending: false };
  return text
    .split(/(\s+)/)
    .map((piece) => (/^\s*$/.test(piece) ? piece : redactWord(piece, state)))
    .join("");
}

/**
 * The safe form of one field value. The value is redacted before it is joined
 * with its key, so the URL check sees the bare value. A key that names a
 * location always loses its query, and a credential key always loses its value.
 */
function redactFieldValue(key: string, value: string): string {
  if (isCredentialKey(key)) return REDACTED;
  return redactWords(URL_KEY.test(key) ? stripQuery(value) : value);
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
 * the call sites: a credential key is replaced, a credential shape is replaced
 * whatever its key, and the query or fragment is dropped from any value that
 * names a location or looks like a URL. A caller cannot leak one by accident.
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
    const sink = this.#sink();
    if (sink === undefined) return;

    this.#flushing = true;
    const lines = this.#entries;
    this.#entries = [];
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
    const parts = [
      this.#now().toISOString(),
      level.toUpperCase(),
      area,
      redactWords(oneLine(message)),
    ];
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (value === undefined) continue;
      parts.push(`${key}=${redactFieldValue(key, oneLine(String(value)))}`);
    }
    this.#entries.push(parts.join(" "));
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

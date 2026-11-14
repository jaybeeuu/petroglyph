import { isRecord } from "./validate.js";

/** Where the plugin writes its diagnostics log, relative to the vault root. */
export const LOG_PATH = ".obsidian/plugins/petroglyph/petroglyph.log";

/** Entries held in memory between flushes; a whole feed of 48 files fits easily. */
export const MAX_BUFFERED_ENTRIES = 500;

/** Approximate size, in characters, at which the log rotates to `petroglyph.log.1`. */
export const ROTATE_BYTES = 256 * 1024;

/**
 * How an allow-listed value is written. A location loses its query; a text value
 * runs every shape test; an identifier keeps its own shape, which is often the
 * diagnostic itself — a feed `nextToken` is base64 of JSON and would otherwise
 * look like a credential.
 */
type FieldKind = "identifier" | "location" | "text";

/**
 * The field keys a call site may emit, and how each one is written. A key
 * outside this list loses its value, so the list is the contract: a caller adds
 * the field here or it is redacted. Every key is lower case, so a field matches
 * whatever its spelling.
 */
const FIELD_KIND = new Map<string, FieldKind>([
  ["activeprofileid", "identifier"],
  ["apibaseurl", "location"],
  ["bytes", "identifier"],
  ["cursor", "identifier"],
  ["cursors", "identifier"],
  ["elapsedms", "identifier"],
  ["error", "text"],
  ["files", "identifier"],
  ["itemid", "identifier"],
  ["nexttoken", "identifier"],
  ["onedrivestatus", "identifier"],
  ["path", "location"],
  ["reason", "text"],
  ["resettoken", "identifier"],
  ["status", "identifier"],
  ["url", "location"],
  ["version", "identifier"],
]);

/** An HTTP auth scheme: the word after it is the credential, whatever its shape. */
const SCHEME_WORD = /^(?:basic|bearer|digest|negotiate|ntlm)$/i;

/** A header name that carries a credential in the word after it. */
const CREDENTIAL_HEADER =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|www-authenticate)$/i;

/** A header name and an auth scheme in one word: `Authorization:Basic`. */
const HEADER_SCHEME =
  /^(?:authorization|proxy-authorization|www-authenticate):(?:basic|bearer|digest|negotiate|ntlm)$/i;

/** A word that ends with a scheme after an equals sign: `key=Bearer`. */
const TRAILING_SCHEME = /=(?:basic|bearer|digest|negotiate|ntlm)$/i;

/**
 * The name of a `name=value` pair that marks the value as a credential. This
 * catches the shape on its own, without the field key or a parameter list.
 */
const CREDENTIAL_NAME =
  /(?:token|secret|password|passwd|passphrase|credential|cookie|session|auth|api[-_]?key|sig|signature|sas|private|nonce)/i;

/**
 * Where a location stops being a path: a query, a fragment, or a semicolon
 * parameter, literal or percent-encoded, however many times it is encoded.
 */
const LOCATION_MARKER = /[?#;]|%(?:25)*(?:3f|23|3b)/i;

/** A JWT, or one half of one split across two fields: base64url of `{"`. */
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{8,}(?:\.|$)/;

/** A run of lowercase hex long enough to be a token or a hash, not a word. */
const HEX_RUN = /[0-9a-f]{32,}/;

/** Text that only an encoded blob produces: long, mixed case, and mixed with digits. */
const OPAQUE_RUN = /[A-Za-z0-9+/_=]{20,}/g;

/** A word drawn only from the standard base64 alphabet, with optional padding. */
const BASE64_WORD = /^[A-Za-z0-9+/]{8,}={0,2}$/;

/** Written in place of a credential. */
const REDACTED = "[redacted]";

/** Punctuation that trails a word without belonging to it. */
const TRAILING_PUNCTUATION = /[),.;:!?\]}>"']+$/;

/** A URL scheme in any case; the capability URL need not be lowercase. */
const ANY_SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;

/** A host with a dot, a dotted quad, or `localhost`, with or without a port. */
const HOST_LIKE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$|^(?:\d{1,3}\.){3}\d{1,3}$|^localhost$/i;

/** The concern a log line belongs to. */
export type LogArea = "startup" | "auth" | "feed" | "trigger" | "download" | "vault" | "profile";

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

/** The first query, fragment, or parameter marker in `text`, if it has one. */
function locationMarker(text: string): RegExpExecArray | undefined {
  return LOCATION_MARKER.exec(text) ?? undefined;
}

/**
 * Drops the query, the fragment, and any parameter from a location value. A
 * location field never carries prose, so every marker ends the path. A literal
 * `;` is the one exception: a vault path may contain one, so it only ends the
 * path when a `name=value` pair follows it.
 */
function stripLocation(value: string): string {
  const marker = locationMarker(value);
  if (marker === undefined) return value;
  const head = value.slice(0, marker.index);
  const tail = value.slice(marker.index + marker[0].length);
  if (marker[0] === ";" && head !== "" && !tail.includes("=")) return value;
  return head === "" ? REDACTED : head;
}

/**
 * Drops the same tail from one word of free text, so a capability that follows
 * a `?` never reaches the file. The punctuation of a sentence survives: a `#`
 * or a `;` that a host does not precede, and a marker that ends the word, such
 * as `write?` or `failed;`, leaves the word alone.
 */
function trimWordLocation(word: string): string {
  const marker = locationMarker(word);
  if (marker === undefined) return word;
  const head = word.slice(0, marker.index);
  const tail = word.slice(marker.index + marker[0].length);
  if (tail === "") return word;
  if (head === "") return marker[0] === "?" ? REDACTED : word;
  const optional = marker[0] === "#" || marker[0] === ";";
  if (optional && !isUrlLike(head) && !tail.includes("=")) return word;
  return head;
}

/** The value of a `name=value` pair whose name marks a credential, if any. */
function credentialPairValue(token: string): string | undefined {
  for (const pair of token.matchAll(/(?:^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_.-]*)=([^&=]*)/g)) {
    if (CREDENTIAL_NAME.test(pair[1] ?? "")) return pair[2] ?? "";
  }
  return undefined;
}

/** True when a token holds a long run that only an encoded secret produces. */
function isOpaque(token: string): boolean {
  for (const run of token.match(OPAQUE_RUN) ?? []) {
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)) return true;
  }
  return false;
}

/**
 * True when a word is base64 of printable text, which is how a Basic credential
 * and a short encoded token travel. A word that decodes to plain ASCII is not
 * an ordinary word: of the words a log line carries, only a base64 blob does.
 */
function isBase64Text(word: string): boolean {
  if (!BASE64_WORD.test(word)) return false;
  const remainder = word.length % 4;
  const padded = remainder === 0 ? word : word.padEnd(word.length + 4 - remainder, "=");
  try {
    return /^[\u0020-\u007e]+$/.test(atob(padded));
  } catch {
    return false;
  }
}

/**
 * True when a word carries a credential whatever its name or its text. The
 * encoded-shape tests are optional, because a path and an identifier share the
 * same shape as an encoded secret.
 */
function isEncodedSecret(word: string, checks: RedactChecks): boolean {
  if (!checks.encodedRuns) return false;
  return JWT_SHAPE.test(word) || HEX_RUN.test(word) || isBase64Text(word) || isOpaque(word);
}

/** Carried between two words: a scheme or a header name marks the next one. */
interface WordState {
  pending: boolean;
}

/** Which shape tests a value gets. A location and an identifier skip them. */
interface RedactChecks {
  encodedRuns: boolean;
}

/** The checks a free-text value gets, including the encoded-shape tests. */
const FREE_TEXT: RedactChecks = { encodedRuns: true };

/** The checks a location or an identifier gets; its shape is the diagnostic. */
const PLAIN_TEXT: RedactChecks = { encodedRuns: false };

/**
 * Redacts one whitespace-delimited word of a value or of a message. The tail
 * after a query marker is dropped whatever its parameters; a credential shape is
 * replaced. A word with no credential shape survives, so `status=403` and a
 * question mark in prose still reach the file.
 */
function redactWord(word: string, state: WordState, checks: RedactChecks): string {
  const kept = trimWordLocation(word);
  if (kept === REDACTED) return REDACTED;
  const bare = kept.replace(TRAILING_PUNCTUATION, "");
  const pending = state.pending;
  state.pending = false;

  if (pending) {
    if (!SCHEME_WORD.test(bare)) return REDACTED;
    state.pending = true;
    return kept;
  }
  if (SCHEME_WORD.test(bare) || CREDENTIAL_HEADER.test(bare)) {
    state.pending = true;
    return kept;
  }
  if (HEADER_SCHEME.test(bare)) {
    // The word names the header and the scheme, so the credential follows it.
    state.pending = true;
    return REDACTED;
  }
  const pair = credentialPairValue(kept);
  if (pair !== undefined) {
    // `Authorization=Basic <credential>` names the scheme and the value at once.
    if (SCHEME_WORD.test(pair)) state.pending = true;
    return REDACTED;
  }
  if (TRAILING_SCHEME.test(bare)) {
    state.pending = true;
    return kept;
  }
  if (isEncodedSecret(bare, checks)) return REDACTED;
  return kept;
}

/**
 * Redacts a value or a message word by word. Every check is structural, so a
 * credential inside free text is caught even when no key names one.
 */
function redactWords(text: string, checks: RedactChecks): string {
  const state: WordState = { pending: false };
  return text
    .split(/(\s+)/)
    .map((piece) => (/^\s*$/.test(piece) ? piece : redactWord(piece, state, checks)))
    .join("");
}

/**
 * The safe form of one field. A key outside the allow-list always loses its
 * value, so an unexpected field cannot leak by construction. An allow-listed
 * location loses its query, and keeps the encoded-shape tests off its value.
 */
function redactFieldValue(key: string, value: string): string {
  const kind = FIELD_KIND.get(key.toLowerCase());
  if (kind === undefined) return REDACTED;
  const checks = kind === "text" ? FREE_TEXT : PLAIN_TEXT;
  if (kind !== "location") return redactWords(value, checks);
  const location = stripLocation(value);
  return location === REDACTED ? REDACTED : redactWords(location, checks);
}

/** Collapses line breaks so one entry cannot forge a second log line. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/**
 * A diagnosable text log the agent can read while the plugin runs. Lines are
 * buffered and written in one append per flush; the file rotates at a fixed
 * size so a long session cannot fill the disk.
 *
 * Redaction is an allow-list, so it fails closed by construction: a field is
 * written only when its key is one the call sites declare in `FIELD_KIND`. Any
 * other key loses its value. An allow-listed key that names a location loses
 * its query, fragment, and semicolon parameters, whatever their shape, so a
 * presigned capability cannot reach the file. An allow-listed text value, such
 * as `error`, runs every shape test, so a credential inside an error message is
 * still replaced. An identifier keeps its own shape, because that shape is the
 * diagnostic — a feed `nextToken` is base64 of JSON.
 *
 * Accepted residual: the message channel is free text with no key to check, so
 * it is still filtered by shape. A credential with none of the shapes this pass
 * knows — no JWT prefix, no long hex run, no long mixed-case run, no word that
 * decodes as base64 of printable text, and no `name=value` pair — can reach the
 * file when a call site puts it in the message, and the same holds for such a
 * shape inside an allow-listed text value. An identifier key keeps its value as
 * it is, because a server cursor has the shape of a credential. This residual is
 * acceptable for a plaintext file inside the user's own vault: the
 * non-negotiable credentials — the JWT, the refresh token, the OneDrive tokens,
 * and the presigned query string — all have a shape the pass matches, and they
 * travel in fields, which cannot leak at all.
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
      redactWords(oneLine(message), FREE_TEXT),
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

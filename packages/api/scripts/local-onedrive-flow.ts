import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import type { WriteStream } from "node:fs";

interface GitHubCallbackPayload {
  jwt: string;
  refreshToken: string;
  username: string;
}

interface OneDriveCallbackPayload {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

interface LocalFlowState {
  github?: GitHubCallbackPayload;
  oneDrive?: {
    connected: boolean;
    lastStatus?: string;
  };
  updatedAt?: string;
}

interface FlowCallbacks {
  githubCallbackUrl: string;
  oneDriveCallbackUrl: string;
  waitForGithubCallback: () => Promise<GitHubCallbackPayload>;
  waitForOneDriveCallback: () => Promise<OneDriveCallbackPayload>;
  close: () => Promise<void>;
}

interface LocalFlowOptions {
  apiBaseUrl: string;
  statePath: string;
  callbackPort: number;
  openBrowser?: (url: string) => Promise<void>;
  fetchFn?: typeof fetch;
  callbacks: FlowCallbacks;
  log: Logger;
}

interface AuthUrlResponse {
  url: string;
}

interface OnedriveConnectResponse {
  status: string;
}

interface AuthRefreshResponse {
  jwt: string;
  refreshToken: string;
}

interface StatusResponse {
  oneDriveStatus: string;
  oneDrive: {
    connected: boolean;
  };
  github: {
    connected: boolean;
    username?: string;
  };
}

interface ParsedArgs {
  apiBaseUrl: string;
  statePath: string;
  callbackPort: number;
  noOpen: boolean;
  logPath: string;
}

const DEFAULT_API_BASE_URL = process.env["PETROGLYPH_API_BASE_URL"] ?? "http://localhost:3000";
const DEFAULT_CALLBACK_PORT = Number(process.env["PETROGLYPH_LOCAL_FLOW_PORT"] ?? "8787");
const DEFAULT_STATE_PATH =
  process.env["PETROGLYPH_LOCAL_FLOW_STATE_PATH"] ??
  join(process.cwd(), ".working-docs", "local-onedrive-flow.json");
const DEFAULT_LOG_PATH =
  process.env["PETROGLYPH_LOCAL_FLOW_LOG_PATH"] ??
  join(process.cwd(), ".working-docs", "local-onedrive-flow.log");

function makeLogger(logStream: WriteStream) {
  return function log(level: "INFO" | "ERROR" | "DEBUG", message: string, data?: unknown): void {
    const ts = new Date().toISOString();
    const dataStr = data !== undefined ? `\n  ${JSON.stringify(data, null, 2).replace(/\n/g, "\n  ")}` : "";
    const line = `[${ts}] ${level} ${message}${dataStr}\n`;
    process.stdout.write(line);
    logStream.write(line);
  };
}

type Logger = ReturnType<typeof makeLogger>;

function previewBody(bodyText: string): unknown {
  if (bodyText.length === 0) {
    return "";
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseCallbackPayload(url: URL): GitHubCallbackPayload | OneDriveCallbackPayload {
  const error = stringOrUndefined(url.searchParams.get("error"));
  const errorDescription = stringOrUndefined(url.searchParams.get("error_description"));
  const code = stringOrUndefined(url.searchParams.get("code"));
  const state = stringOrUndefined(url.searchParams.get("state"));
  const jwt = stringOrUndefined(url.searchParams.get("jwt"));
  const refreshToken = stringOrUndefined(url.searchParams.get("refreshToken"));
  const username = stringOrUndefined(url.searchParams.get("username"));

  if (jwt !== undefined && refreshToken !== undefined && username !== undefined) {
    return { jwt, refreshToken, username };
  }

  if (code === undefined || state === undefined) {
    throw new Error(`Callback missing code/state: ${url.toString()}`);
  }

  return {
    code,
    state,
    ...(error !== undefined ? { error } : {}),
    ...(errorDescription !== undefined ? { errorDescription } : {}),
  };
}

async function requestJson<T>(fetchFn: typeof fetch, url: string, init?: RequestInit, log?: Logger): Promise<T> {
  const method = init?.method ?? "GET";
  log?.("DEBUG", `→ ${method} ${url}`);
  const response = await fetchFn(url, init);
  const bodyText = await response.text();
  log?.("DEBUG", `← ${response.status} ${response.statusText} ${url}`, previewBody(bodyText));

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}: ${bodyText}`);
  }

  return JSON.parse(bodyText) as T;
}

function renderCallbackPage(title: string, details: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <pre>${details}</pre>
    <p>You can close this tab.</p>
  </body>
</html>`;
}

async function ensureParentDir(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
}

export async function readLocalState(statePath: string): Promise<LocalFlowState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as LocalFlowState) : {};
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

export async function writeLocalState(statePath: string, state: LocalFlowState): Promise<void> {
  await ensureParentDir(statePath);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function startBrowser(url: string): Promise<void> {
  const browser = process.env["BROWSER"];
  const command =
    browser ??
    (process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open");
  const args =
    process.platform === "win32" && browser === undefined ? ["/c", "start", "", url] : [url];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

export async function startFlowCallbacks(callbackPort: number, log?: Logger): Promise<FlowCallbacks> {
  const pendingGithub: Array<(payload: GitHubCallbackPayload) => void> = [];
  const pendingOneDrive: Array<(payload: OneDriveCallbackPayload) => void> = [];
  let githubResolved: GitHubCallbackPayload | undefined;
  let oneDriveResolved: OneDriveCallbackPayload | undefined;
  const openSockets = new Set<Socket>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${callbackPort}`);
    const pathname = requestUrl.pathname;

    log?.("DEBUG", "Callback server received request", {
      pathname,
      search: requestUrl.search,
    });

    if (pathname !== "/github-callback" && pathname !== "/onedrive-callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const payload = parseCallbackPayload(requestUrl);
    log?.("INFO", "Callback payload parsed", {
      pathname,
      kind: "jwt" in payload ? "github" : "onedrive",
    });

    if ("jwt" in payload) {
      githubResolved = payload;
      while (pendingGithub.length > 0) {
        const resolve = pendingGithub.shift();
        if (resolve) resolve(payload);
      }
    } else {
      oneDriveResolved = payload;
      while (pendingOneDrive.length > 0) {
        const resolve = pendingOneDrive.shift();
        if (resolve) resolve(payload);
      }
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderCallbackPage(
        pathname === "/github-callback" ? "GitHub connected" : "OneDrive callback received",
        JSON.stringify(payload, null, 2),
      ),
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(callbackPort, "127.0.0.1", resolve);
  });

  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => {
      openSockets.delete(socket);
    });
  });

  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      for (const socket of openSockets) {
        socket.destroy();
      }
      openSockets.clear();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

  return {
    githubCallbackUrl: `http://127.0.0.1:${callbackPort}/github-callback`,
    oneDriveCallbackUrl: `http://127.0.0.1:${callbackPort}/onedrive-callback`,
    waitForGithubCallback: () =>
      new Promise<GitHubCallbackPayload>((resolve) => {
        if (githubResolved !== undefined) {
          resolve(githubResolved);
          return;
        }
        pendingGithub.push(resolve);
      }),
    waitForOneDriveCallback: () =>
      new Promise<OneDriveCallbackPayload>((resolve) => {
        if (oneDriveResolved !== undefined) {
          resolve(oneDriveResolved);
          return;
        }
        pendingOneDrive.push(resolve);
      }),
    close,
  };
}

async function openBrowserOrPrint(
  url: string,
  openBrowser?: (url: string) => Promise<void>,
): Promise<void> {
  try {
    if (openBrowser !== undefined) {
      await openBrowser(url);
      return;
    }
    await startBrowser(url);
  } catch {
    console.log(`Open this URL manually:\n${url}`);
  }
}

async function runGitHubLogin(options: LocalFlowOptions): Promise<GitHubCallbackPayload> {
  const fetchFn = options.fetchFn ?? fetch;
  const authUrl = new URL("/auth/url", options.apiBaseUrl);
  authUrl.searchParams.set("returnUri", options.callbacks.githubCallbackUrl);

  options.log("INFO", "Step 1: fetching GitHub auth URL", { url: authUrl.toString() });
  const authUrlResponse = await requestJson<AuthUrlResponse>(fetchFn, authUrl.toString(), undefined, options.log);
  options.log("INFO", "Opening browser for GitHub login", { githubUrl: authUrlResponse.url });
  await openBrowserOrPrint(authUrlResponse.url, options.openBrowser);

  options.log("INFO", "Waiting for GitHub callback...");
  const callback = await options.callbacks.waitForGithubCallback();
  options.log("INFO", "GitHub callback received", { username: callback.username });
  return callback;
}

async function runOneDriveConnect(
  options: LocalFlowOptions,
  jwt: string,
): Promise<OnedriveConnectResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const authUrl = new URL("/onedrive/auth-url", options.apiBaseUrl);
  authUrl.searchParams.set("harnessCallbackUri", options.callbacks.oneDriveCallbackUrl);

  options.log("INFO", "Step 2: fetching OneDrive auth URL", { url: authUrl.toString() });
  const authUrlResponse = await requestJson<AuthUrlResponse>(fetchFn, authUrl.toString(), {
    headers: { Authorization: `Bearer ${jwt}` },
  }, options.log);

  options.log("INFO", "Opening browser for OneDrive login", { microsoftUrl: authUrlResponse.url });
  await openBrowserOrPrint(authUrlResponse.url, options.openBrowser);

  options.log("INFO", "Waiting for OneDrive callback...");
  const callback = await options.callbacks.waitForOneDriveCallback();
  options.log("INFO", "OneDrive callback received", {
    code: callback.code ? `${callback.code.slice(0, 8)}…` : undefined,
    state: callback.state ? `${callback.state.slice(0, 16)}…` : undefined,
    error: callback.error,
    errorDescription: callback.errorDescription,
  });

  if (callback.error !== undefined) {
    throw new Error(
      callback.errorDescription !== undefined
        ? `${callback.error}: ${callback.errorDescription}`
        : callback.error,
    );
  }

  options.log("INFO", "Step 3: POST /onedrive/connect");
  const connectResponse = await requestJson<OnedriveConnectResponse>(
    fetchFn,
    new URL("/onedrive/connect", options.apiBaseUrl).toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: callback.code, state: callback.state }),
    },
    options.log,
  );

  options.log("INFO", "OneDrive connect response", connectResponse);
  return connectResponse;
}

async function refreshJwt(
  options: LocalFlowOptions,
  refreshToken: string,
): Promise<AuthRefreshResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  options.log("INFO", "Step 5: POST /auth/refresh");
  return requestJson<AuthRefreshResponse>(
    fetchFn,
    new URL("/auth/refresh", options.apiBaseUrl).toString(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    },
    options.log,
  );
}

async function fetchStatus(options: LocalFlowOptions, jwt: string): Promise<StatusResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  options.log("INFO", "Step 4: GET /status");
  return requestJson<StatusResponse>(fetchFn, new URL("/status", options.apiBaseUrl).toString(), {
    headers: { Authorization: `Bearer ${jwt}` },
  }, options.log);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    apiBaseUrl: DEFAULT_API_BASE_URL,
    statePath: DEFAULT_STATE_PATH,
    callbackPort: DEFAULT_CALLBACK_PORT,
    noOpen: false,
    logPath: DEFAULT_LOG_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--api-base-url") {
      const value = argv[i + 1];
      if (!value) throw new Error("--api-base-url requires a value");
      parsed.apiBaseUrl = value;
      i += 1;
      continue;
    }
    if (arg === "--state-path") {
      const value = argv[i + 1];
      if (!value) throw new Error("--state-path requires a value");
      parsed.statePath = value;
      i += 1;
      continue;
    }
    if (arg === "--callback-port") {
      const value = argv[i + 1];
      if (!value) throw new Error("--callback-port requires a value");
      const port = Number(value);
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error("--callback-port must be a positive integer");
      }
      parsed.callbackPort = port;
      i += 1;
      continue;
    }
    if (arg === "--no-open") {
      parsed.noOpen = true;
      continue;
    }
    if (arg === "--log-path") {
      const value = argv[i + 1];
      if (!value) throw new Error("--log-path requires a value");
      parsed.logPath = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export async function runLocalFlow(options: LocalFlowOptions): Promise<LocalFlowState> {
  const currentState = await readLocalState(options.statePath);
  const nextState: LocalFlowState = { ...currentState };
  options.log("INFO", "Starting local OneDrive flow", { apiBaseUrl: options.apiBaseUrl });

  const github = await runGitHubLogin(options);
  nextState.github = github;
  nextState.updatedAt = new Date().toISOString();
  await writeLocalState(options.statePath, nextState);
  options.log("INFO", "GitHub state persisted", { username: github.username });

  const connectResponse = await runOneDriveConnect(options, github.jwt);
  nextState.oneDrive = {
    connected: connectResponse.status === "connected",
    lastStatus: connectResponse.status,
  };
  nextState.updatedAt = new Date().toISOString();
  await writeLocalState(options.statePath, nextState);

  const status = await fetchStatus(options, github.jwt);
  options.log("INFO", "Status response", status);
  if (!status.oneDrive.connected) {
    throw new Error(`Expected OneDrive to be connected, got ${status.oneDriveStatus}`);
  }

  const refreshed = await refreshJwt(options, github.refreshToken);
  nextState.github = {
    jwt: refreshed.jwt,
    refreshToken: refreshed.refreshToken,
    username: github.username,
  };
  nextState.updatedAt = new Date().toISOString();
  await writeLocalState(options.statePath, nextState);
  options.log("INFO", "Flow complete ✓", { oneDriveStatus: status.oneDriveStatus });

  return nextState;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(join(args.logPath, ".."), { recursive: true });
  const logStream = createWriteStream(args.logPath, { flags: "a" });
  const log = makeLogger(logStream);

  log("INFO", "=== local-onedrive-flow started ===", { args: { ...args, logPath: args.logPath } });

  const callbacks = await startFlowCallbacks(args.callbackPort, log);
  log("INFO", `Callback server listening on port ${args.callbackPort}`);

  const shutdown = (code: number): void => {
    log("INFO", `Shutting down (code ${code})`);
    void callbacks.close().finally(() => {
      logStream.end(() => process.exit(code));
    });
  };

  process.on("SIGINT", () => {
    shutdown(130);
  });
  process.on("SIGTERM", () => {
    shutdown(143);
  });

  try {
    const flowOptions: LocalFlowOptions = {
      apiBaseUrl: args.apiBaseUrl,
      statePath: args.statePath,
      callbackPort: args.callbackPort,
      callbacks,
      fetchFn: fetch,
      log,
    };

    if (args.noOpen) {
      flowOptions.openBrowser = (url: string) => {
        log("INFO", `Open this URL manually:\n${url}`);
        return Promise.resolve();
      };
    }

    const state = await runLocalFlow(flowOptions);

    log("INFO", "Final state", state);
  } catch (error) {
    log("ERROR", "Flow failed", error instanceof Error ? { message: error.message, stack: error.stack } : error);
    throw error;
  } finally {
    await callbacks.close();
    await new Promise<void>((resolve) => logStream.end(resolve));
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}

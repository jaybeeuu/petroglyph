import { pathToFileURL } from "node:url";

import pRetry from "p-retry";

interface UnknownObject {
  readonly [key: string]: unknown;
}

interface SmokeTestResult {
  readonly path: string;
  readonly durationMs: number;
}

export interface SmokeTestSettings {
  readonly requestTimeoutMs: number;
  readonly maxResponseTimeMs: number;
  readonly retryAttempts: number;
  readonly retryDelayMs: number;
}

export interface SmokeTestOptions {
  readonly lambdaFunctionUrl: string;
  readonly fetchFn: typeof fetch;
  readonly log: (message: string) => void;
  readonly settings: SmokeTestSettings;
}

const MAX_RESPONSE_TIME_MS = Number.parseInt(
  process.env["SMOKE_TEST_MAX_RESPONSE_TIME_MS"] ?? "5000",
  10,
);
const REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env["SMOKE_TEST_REQUEST_TIMEOUT_MS"] ?? "10000",
  10,
);
const RETRY_ATTEMPTS = Number.parseInt(process.env["SMOKE_TEST_RETRY_ATTEMPTS"] ?? "3", 10);
const RETRY_DELAY_MS = Number.parseInt(process.env["SMOKE_TEST_RETRY_DELAY_MS"] ?? "1000", 10);
const AUTH_URL_PATH = "/auth/url?returnUri=https%3A%2F%2Fexample.com";
const lambdaFunctionUrl = process.env["LAMBDA_FUNCTION_URL"];

class HttpResponseError extends Error {
  readonly status: number;

  constructor(path: string, status: number, responseText: string) {
    super(`${path} returned ${status}: ${responseText}`);
    this.name = "HttpResponseError";
    this.status = status;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRecord(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null;
}

function assertConfiguredNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return true;
  }

  return error.message.includes("fetch failed");
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpResponseError) {
    return isRetryableStatus(error.status);
  }

  return isTransientNetworkError(error);
}

function assertStatusOkResponse(body: unknown): void {
  if (!isRecord(body) || body["status"] !== "ok") {
    throw new Error('Expected /health response body to equal {"status":"ok"}');
  }
}

function assertGitHubAuthUrlResponse(body: unknown): void {
  if (!isRecord(body) || typeof body["url"] !== "string") {
    throw new Error('Expected /auth/url response body to include a string "url" field');
  }

  const authUrl = new URL(body["url"]);

  if (
    authUrl.protocol !== "https:" ||
    authUrl.host !== "github.com" ||
    authUrl.pathname !== "/login/oauth/authorize"
  ) {
    throw new Error(`Expected GitHub OAuth URL, received ${authUrl.toString()}`);
  }

  const clientId = authUrl.searchParams.get("client_id");
  const redirectUri = authUrl.searchParams.get("redirect_uri");
  const scope = authUrl.searchParams.get("scope");
  const state = authUrl.searchParams.get("state");

  if (!clientId) {
    throw new Error("Expected GitHub OAuth URL to include client_id");
  }

  if (!redirectUri) {
    throw new Error("Expected GitHub OAuth URL to include redirect_uri");
  }

  if (scope !== "read:user") {
    throw new Error(`Expected GitHub OAuth URL scope=read:user, received ${scope ?? "<missing>"}`);
  }

  if (!state) {
    throw new Error("Expected GitHub OAuth URL to include state");
  }
}

function assertResponseTime(durationMs: number, path: string, maxResponseTimeMs: number): void {
  if (durationMs >= maxResponseTimeMs) {
    throw new Error(
      `${path} responded in ${durationMs}ms, which exceeds the ${maxResponseTimeMs}ms threshold`,
    );
  }
}

async function fetchJson(
  path: string,
  options: SmokeTestOptions,
): Promise<{ readonly body: unknown; readonly durationMs: number }> {
  const requestUrl = new URL(path, options.lambdaFunctionUrl);
  const startedAt = performance.now();
  const response = await options.fetchFn(requestUrl, {
    headers: {
      accept: "application/json",
    },
    signal: AbortSignal.timeout(options.settings.requestTimeoutMs),
  });
  const durationMs = Math.round(performance.now() - startedAt);
  const responseText = await response.text();

  if (response.status !== 200) {
    throw new HttpResponseError(path, response.status, responseText);
  }

  let body: unknown;

  try {
    body = JSON.parse(responseText) as unknown;
  } catch (error) {
    throw new Error(`${path} returned invalid JSON: ${getErrorMessage(error)}`);
  }

  return {
    body,
    durationMs,
  };
}

function fetchWithRetry(
  path: string,
  options: SmokeTestOptions,
): Promise<{ readonly body: unknown; readonly durationMs: number }> {
  const { retryAttempts, retryDelayMs } = options.settings;

  return pRetry(() => fetchJson(path, options), {
    retries: retryAttempts - 1,
    minTimeout: retryDelayMs,
    factor: 2,
    randomize: true,
    shouldRetry: ({ error }) => isRetryableError(error),
    onFailedAttempt: ({ error, attemptNumber, retriesLeft, retryDelay }) => {
      if (retriesLeft > 0 && isRetryableError(error)) {
        options.log(
          `Retrying ${path} after attempt ${attemptNumber} failed: ${getErrorMessage(error)} (waiting ${retryDelay}ms)`,
        );
      }
    },
  });
}

export async function runSmokeTest(
  path: string,
  validateBody: (body: unknown) => void,
  options: SmokeTestOptions,
): Promise<SmokeTestResult> {
  const { body, durationMs } = await fetchWithRetry(path, options);

  validateBody(body);
  assertResponseTime(durationMs, path, options.settings.maxResponseTimeMs);

  options.log(`PASS ${path} (${durationMs}ms)`);

  return {
    path,
    durationMs,
  } satisfies SmokeTestResult;
}

async function main(): Promise<void> {
  if (!lambdaFunctionUrl) {
    console.error("Smoke test failed: LAMBDA_FUNCTION_URL is required");
    process.exit(1);
  }

  assertConfiguredNumber(MAX_RESPONSE_TIME_MS, "SMOKE_TEST_MAX_RESPONSE_TIME_MS");
  assertConfiguredNumber(REQUEST_TIMEOUT_MS, "SMOKE_TEST_REQUEST_TIMEOUT_MS");
  assertConfiguredNumber(RETRY_ATTEMPTS, "SMOKE_TEST_RETRY_ATTEMPTS");
  assertConfiguredNumber(RETRY_DELAY_MS, "SMOKE_TEST_RETRY_DELAY_MS");

  try {
    new URL(lambdaFunctionUrl);
  } catch (error) {
    console.error(`Smoke test failed: invalid LAMBDA_FUNCTION_URL (${getErrorMessage(error)})`);
    process.exit(1);
  }

  console.log(`Running smoke test against ${lambdaFunctionUrl}`);

  const options: SmokeTestOptions = {
    lambdaFunctionUrl,
    fetchFn: fetch,
    log: (message: string) => {
      console.log(message);
    },
    settings: {
      maxResponseTimeMs: MAX_RESPONSE_TIME_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      retryAttempts: RETRY_ATTEMPTS,
      retryDelayMs: RETRY_DELAY_MS,
    },
  };

  const failures: string[] = [];
  const results: SmokeTestResult[] = [];

  for (const [path, validator] of [
    ["/health", assertStatusOkResponse],
    [AUTH_URL_PATH, assertGitHubAuthUrlResponse],
  ] satisfies ReadonlyArray<readonly [string, (body: unknown) => void]>) {
    try {
      const result = await runSmokeTest(path, validator, options);
      results.push(result);
    } catch (error) {
      const message = `${path}: ${getErrorMessage(error)}`;
      failures.push(message);
      console.error(`FAIL ${message}`);
    }
  }

  if (failures.length > 0) {
    console.error("Smoke test failed");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    process.exit(1);
  }

  const slowestResponseMs = Math.max(...results.map((result) => result.durationMs));
  console.log(`Smoke test passed (slowest response ${slowestResponseMs}ms)`);
  process.exit(0);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}

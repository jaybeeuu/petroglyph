interface UnknownObject {
  readonly [key: string]: unknown;
}

interface SmokeTestResult {
  readonly path: string;
  readonly durationMs: number;
}

const MAX_RESPONSE_TIME_MS = Number.parseInt(
  process.env["SMOKE_TEST_MAX_RESPONSE_TIME_MS"] ?? "5000",
  10,
);
const REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env["SMOKE_TEST_REQUEST_TIMEOUT_MS"] ?? "10000",
  10,
);
const lambdaFunctionUrl = process.env["LAMBDA_FUNCTION_URL"];

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

function assertResponseTime(durationMs: number, path: string): void {
  if (durationMs >= MAX_RESPONSE_TIME_MS) {
    throw new Error(
      `${path} responded in ${durationMs}ms, which exceeds the ${MAX_RESPONSE_TIME_MS}ms threshold`,
    );
  }
}

async function fetchJson(
  path: string,
): Promise<{ readonly body: unknown; readonly durationMs: number }> {
  if (!lambdaFunctionUrl) {
    throw new Error("LAMBDA_FUNCTION_URL is required");
  }

  const requestUrl = new URL(path, lambdaFunctionUrl);
  const startedAt = performance.now();
  const response = await fetch(requestUrl, {
    headers: {
      accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const durationMs = Math.round(performance.now() - startedAt);
  const responseText = await response.text();

  if (response.status !== 200) {
    throw new Error(`${path} returned ${response.status}: ${responseText}`);
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

async function runSmokeTest(
  path: string,
  validateBody: (body: unknown) => void,
): Promise<SmokeTestResult> {
  const { body, durationMs } = await fetchJson(path);

  validateBody(body);
  assertResponseTime(durationMs, path);

  console.log(`PASS ${path} (${durationMs}ms)`);

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

  try {
    new URL(lambdaFunctionUrl);
  } catch (error) {
    console.error(`Smoke test failed: invalid LAMBDA_FUNCTION_URL (${getErrorMessage(error)})`);
    process.exit(1);
  }

  console.log(`Running smoke test against ${lambdaFunctionUrl}`);

  const failures: string[] = [];
  const results: SmokeTestResult[] = [];

  for (const [path, validator] of [
    ["/health", assertStatusOkResponse],
    ["/auth/url", assertGitHubAuthUrlResponse],
  ] satisfies ReadonlyArray<readonly [string, (body: unknown) => void]>) {
    try {
      const result = await runSmokeTest(path, validator);
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

await main();

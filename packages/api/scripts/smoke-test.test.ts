import { describe, expect, it, vi } from "vitest";
import { runSmokeTest, type SmokeTestOptions, type SmokeTestSettings } from "./smoke-test.js";

function createSettings(overrides: Partial<SmokeTestSettings> = {}): SmokeTestSettings {
  return {
    requestTimeoutMs: 10_000,
    maxResponseTimeMs: 5_000,
    retryAttempts: 3,
    retryDelayMs: 1_000,
    ...overrides,
  };
}

function createOptions(overrides: Partial<SmokeTestOptions> = {}): SmokeTestOptions {
  return {
    lambdaFunctionUrl: "https://api.example.test",
    fetchFn: () => Promise.reject(new Error("unexpected fetch")),
    sleep: () => Promise.resolve(),
    log: () => undefined,
    settings: createSettings(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const acceptAnyBody = (): void => undefined;

describe("runSmokeTest", () => {
  it("retries a transient network failure and passes when a later attempt succeeds", async () => {
    const fetchFn = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>();
    sleep.mockResolvedValue(undefined);

    const result = await runSmokeTest("/health", acceptAnyBody, createOptions({ fetchFn, sleep }));

    expect(result.path).toBe("/health");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("retries a retryable 503 status and passes when the next attempt succeeds", async () => {
    const fetchFn = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>();
    sleep.mockResolvedValue(undefined);

    const result = await runSmokeTest("/health", acceptAnyBody, createOptions({ fetchFn, sleep }));

    expect(result.path).toBe("/health");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails fast on a non-retryable 400 status without retrying", async () => {
    const fetchFn = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(jsonResponse({ error: "bad request" }, 400));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>();
    sleep.mockResolvedValue(undefined);

    await expect(
      runSmokeTest("/health", acceptAnyBody, createOptions({ fetchFn, sleep })),
    ).rejects.toThrow("returned 400");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails fast when a successful response fails body validation without retrying", async () => {
    const fetchFn = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(jsonResponse({ status: "not-ok" }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>();
    sleep.mockResolvedValue(undefined);
    const rejectInvalidBody = (): void => {
      throw new Error("invalid response body");
    };

    await expect(
      runSmokeTest("/health", rejectInvalidBody, createOptions({ fetchFn, sleep })),
    ).rejects.toThrow("invalid response body");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after the configured number of attempts and rethrows the last failure", async () => {
    const fetchFn = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValue(new TypeError("fetch failed"));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>();
    sleep.mockResolvedValue(undefined);

    await expect(
      runSmokeTest(
        "/health",
        acceptAnyBody,
        createOptions({ fetchFn, sleep, settings: createSettings({ retryAttempts: 2 }) }),
      ),
    ).rejects.toThrow("fetch failed");

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("applies exponential backoff between attempts", async () => {
    const fetchFn = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValue(new TypeError("fetch failed"));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>();
    sleep.mockResolvedValue(undefined);

    await expect(
      runSmokeTest(
        "/health",
        acceptAnyBody,
        createOptions({
          fetchFn,
          sleep,
          settings: createSettings({ retryAttempts: 3, retryDelayMs: 500 }),
        }),
      ),
    ).rejects.toThrow("fetch failed");

    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([500, 1_000]);
  });
});

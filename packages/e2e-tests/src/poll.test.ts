import { describe, expect, it } from "vitest";
import { waitForRecord, type SmokeClock } from "./poll.js";

function createClock(): SmokeClock & { advance: (milliseconds: number) => void } {
  let current = 0;
  return {
    now: () => current,
    sleep: (milliseconds) => {
      current += milliseconds;
      return Promise.resolve();
    },
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

describe("waitForRecord", () => {
  it("returns immediately when the record is already there", async () => {
    const clock = createClock();

    const result = await waitForRecord({
      read: () => Promise.resolve({ itemId: "smoke-item" }),
      label: "the staged record",
      timeoutMs: 10_000,
      intervalMs: 1_000,
      clock,
      log: () => undefined,
    });

    expect(result).toEqual({ itemId: "smoke-item" });
  });

  it("keeps polling until the reader yields a record", async () => {
    const clock = createClock();
    let attempts = 0;

    const result = await waitForRecord({
      read: () => {
        attempts += 1;
        return Promise.resolve(attempts >= 3 ? { itemId: "smoke-item" } : null);
      },
      label: "the staged record",
      timeoutMs: 10_000,
      intervalMs: 1_000,
      clock,
      log: () => undefined,
    });

    expect(result).toEqual({ itemId: "smoke-item" });
    expect(attempts).toBe(3);
  });

  it("throws once the deadline passes with no record", async () => {
    const clock = createClock();

    await expect(
      waitForRecord({
        read: () => Promise.resolve(null),
        label: "the staged record",
        timeoutMs: 5_000,
        intervalMs: 1_000,
        clock,
        log: () => undefined,
      }),
    ).rejects.toThrow(/timed out after 5000ms waiting for the staged record/);
  });
});

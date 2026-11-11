import { describe, expect, it, vi } from "vitest";
import { DEDUPE_WINDOW_SECONDS, createCatchUpHandler } from "./catch-up.js";
import type { Connection } from "./catch-up.js";

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    userId: "github|1",
    provider: "onedrive",
    reconnectRequired: false,
    ...overrides,
  };
}

/** A fixed instant inside a dedupe window, expressed in milliseconds. */
const NOW_MS = 1_700_000_000_000;

describe("createCatchUpHandler", () => {
  it("enqueues one bell per healthy connection", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const handler = createCatchUpHandler({
      listConnections: () =>
        Promise.resolve([
          createConnection({ userId: "github|1" }),
          createConnection({ userId: "github|2" }),
        ]),
      enqueue,
      now: () => NOW_MS,
    });

    await handler();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ bell: { userId: "github|1", provider: "onedrive" } }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ bell: { userId: "github|2", provider: "onedrive" } }),
    );
  });

  it("addresses each connection's bells by that connection's own identity", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const handler = createCatchUpHandler({
      listConnections: () =>
        Promise.resolve([
          createConnection({ userId: "github|1" }),
          createConnection({ userId: "github|2" }),
        ]),
      enqueue,
      now: () => NOW_MS,
    });

    await handler();

    const [firstCall, secondCall] = enqueue.mock.calls as [
      [{ dedupeIdentity: string }],
      [{ dedupeIdentity: string }],
    ];
    expect(firstCall[0].dedupeIdentity).toMatch(/^github\|1:onedrive:/);
    expect(secondCall[0].dedupeIdentity).toMatch(/^github\|2:onedrive:/);
  });

  it("skips a connection that needs reconnecting", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const handler = createCatchUpHandler({
      listConnections: () =>
        Promise.resolve([
          createConnection({ userId: "github|1", reconnectRequired: true }),
          createConnection({ userId: "github|2" }),
        ]),
      enqueue,
      now: () => NOW_MS,
    });

    await handler();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ bell: { userId: "github|2", provider: "onedrive" } }),
    );
  });

  it("shares one dedupe identity across sweeps in the same window", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const handler = createCatchUpHandler({
      listConnections: () => Promise.resolve([createConnection()]),
      enqueue,
      now: () => NOW_MS,
    });

    await handler();
    await handler();

    const [firstCall, secondCall] = enqueue.mock.calls as [
      [{ dedupeIdentity: string }],
      [{ dedupeIdentity: string }],
    ];
    expect(firstCall[0].dedupeIdentity).toBe(secondCall[0].dedupeIdentity);
  });

  it("uses a different dedupe identity once the window has passed", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    let nowMs = NOW_MS;
    const handler = createCatchUpHandler({
      listConnections: () => Promise.resolve([createConnection()]),
      enqueue,
      now: () => nowMs,
    });

    await handler();
    nowMs = NOW_MS + DEDUPE_WINDOW_SECONDS * 1000;
    await handler();

    const [firstCall, secondCall] = enqueue.mock.calls as [
      [{ dedupeIdentity: string }],
      [{ dedupeIdentity: string }],
    ];
    expect(firstCall[0].dedupeIdentity).not.toBe(secondCall[0].dedupeIdentity);
  });

  it("re-bells when a retry crosses a bucket boundary inside the five-minute window", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    let nowMs = 1_700_000_000_000;
    const handler = createCatchUpHandler({
      listConnections: () => Promise.resolve([createConnection()]),
      enqueue,
      now: () => nowMs,
    });

    // The buckets are aligned to the epoch, so a sweep at 100_000 ms before a
    // boundary and a retry 1 ms after it are two ids: the real collapse window
    // is five minutes minus the distance from the send to the boundary.
    const sendMs = nowMs;
    const retryMs = sendMs + 100_001;
    expect(retryMs - sendMs).toBeLessThan(DEDUPE_WINDOW_SECONDS * 1000);

    await handler();
    nowMs = retryMs;
    await handler();

    const [firstCall, secondCall] = enqueue.mock.calls as [
      [{ dedupeIdentity: string }],
      [{ dedupeIdentity: string }],
    ];
    expect(firstCall[0].dedupeIdentity).not.toBe(secondCall[0].dedupeIdentity);
  });

  it("fails the sweep when a bell cannot be enqueued, so the schedule retries", async () => {
    const handler = createCatchUpHandler({
      listConnections: () => Promise.resolve([createConnection()]),
      enqueue: vi.fn().mockRejectedValue(new Error("sqs unavailable")),
      now: () => NOW_MS,
    });

    await expect(handler()).rejects.toThrow("sqs unavailable");
  });

  it("does nothing when no connection is stored", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const handler = createCatchUpHandler({
      listConnections: () => Promise.resolve([]),
      enqueue,
      now: () => NOW_MS,
    });

    await handler();

    expect(enqueue).not.toHaveBeenCalled();
  });
});

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

  it("groups each connection's bells on its own FIFO group", async () => {
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

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ messageGroupId: "github|1:onedrive" }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ messageGroupId: "github|2:onedrive" }),
    );
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

  it("shares one dedupe id across sweeps in the same window", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const handler = createCatchUpHandler({
      listConnections: () => Promise.resolve([createConnection()]),
      enqueue,
      now: () => NOW_MS,
    });

    await handler();
    await handler();

    const [firstCall, secondCall] = enqueue.mock.calls as [
      [{ dedupeId: string }],
      [{ dedupeId: string }],
    ];
    expect(firstCall[0].dedupeId).toBe(secondCall[0].dedupeId);
  });

  it("uses a different dedupe id once the window has passed", async () => {
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
      [{ dedupeId: string }],
      [{ dedupeId: string }],
    ];
    expect(firstCall[0].dedupeId).not.toBe(secondCall[0].dedupeId);
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

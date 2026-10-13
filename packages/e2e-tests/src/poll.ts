export interface SmokeClock {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface WaitForRecordOptions<Record> {
  read: () => Promise<Record | null>;
  label: string;
  timeoutMs: number;
  intervalMs: number;
  clock: SmokeClock;
  log: (message: string) => void;
}

/**
 * Polls a reader until it yields a record or the deadline passes. The clock is
 * injected so tests drive time without sleeping; a real timeout is a hard
 * failure — the deployed path did not complete within the budget.
 */
export async function waitForRecord<Record>(
  options: WaitForRecordOptions<Record>,
): Promise<Record> {
  const deadline = options.clock.now() + options.timeoutMs;
  while (options.clock.now() < deadline) {
    const record = await options.read();
    if (record !== null) {
      return record;
    }
    options.log(`waiting for ${options.label}...`);
    await options.clock.sleep(options.intervalMs);
  }
  const final = await options.read();
  if (final !== null) {
    return final;
  }
  throw new Error(`timed out after ${options.timeoutMs}ms waiting for ${options.label}`);
}

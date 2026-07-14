export type PacerOutcome = { ok: boolean; retryAfterMs?: number };

export type PacerOptions = {
  startIntervalMs?: number;
  minIntervalMs: number;
  maxConcurrency: number;
  warmup?: number;
  increaseAfter?: number;
  latencyAlpha?: number;
  spikeFactor?: number;
  decreaseFactor?: number;
  adaptive?: boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type PacerStats = { intervalMs: number; concurrency: number; baselineMs?: number };

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Converts Retry-After seconds or an HTTP-date to a non-negative duration. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function createPacer(options: PacerOptions): {
  run<T>(task: () => Promise<T>, classify: (result: T) => PacerOutcome): Promise<T>;
  stats(): PacerStats;
} {
  const startIntervalMs = Math.max(0, options.startIntervalMs ?? 1000);
  const minIntervalMs = Math.max(0, options.minIntervalMs);
  const maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
  const warmup = Math.max(0, Math.floor(options.warmup ?? 5));
  const increaseAfter = Math.max(1, Math.floor(options.increaseAfter ?? 5));
  const latencyAlpha = Math.min(1, Math.max(0, options.latencyAlpha ?? 0.2));
  const spikeFactor = Math.max(0, options.spikeFactor ?? 2);
  const decreaseFactor = Math.min(1, Math.max(0, options.decreaseFactor ?? 0.5));
  const adaptive = options.adaptive ?? true;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  let intervalMs = adaptive ? startIntervalMs : minIntervalMs;
  let concurrency = adaptive ? 1 : maxConcurrency;
  let inFlight = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  let nextAllowed = Number.NEGATIVE_INFINITY;
  let ewmaMs: number | undefined;
  let warmupEwmaMs: number | undefined;
  let warmupSuccesses = 0;
  let baselineMs: number | undefined;
  let healthyStreak = 0;
  const slotWaiters: Array<() => void> = [];
  let reservedSlots = 0;

  const updateEwma = (previous: number | undefined, sample: number): number => previous === undefined
    ? sample
    : (latencyAlpha * sample) + ((1 - latencyAlpha) * previous);

  // Reserve a slot before resolving a waiter so simultaneous releases cannot over-allocate capacity.
  const drainSlotWaiters = (): void => {
    while (slotWaiters.length > 0 && inFlight + reservedSlots < Math.floor(concurrency)) {
      reservedSlots += 1;
      slotWaiters.shift()?.();
    }
  };

  const acquire = async (): Promise<void> => {
    let hasReservedSlot = false;
    const waitForSlot = async (front = false): Promise<void> => {
      await new Promise<void>((resolve) => {
        const notify = () => { hasReservedSlot = true; resolve(); };
        if (front) slotWaiters.unshift(notify);
        else slotWaiters.push(notify);
        drainSlotWaiters();
      });
    };
    while (true) {
      const current = now();
      const waitForStart = Math.max(0, lastStart + intervalMs - current, nextAllowed - current);
      const slotAvailable = hasReservedSlot
        ? inFlight < Math.floor(concurrency)
        : slotWaiters.length === 0 && inFlight + reservedSlots < Math.floor(concurrency);
      if (slotAvailable && waitForStart <= 0) {
        if (hasReservedSlot) reservedSlots -= 1;
        lastStart = current;
        inFlight += 1;
        return;
      }
      if (!slotAvailable) {
        if (hasReservedSlot) {
          reservedSlots -= 1;
          hasReservedSlot = false;
          await waitForSlot(true);
        } else {
          await waitForSlot();
        }
      } else {
        await sleep(Math.max(1, waitForStart));
      }
    }
  };

  const adjust = (outcome: PacerOutcome, latencyMs: number): void => {
    if (!adaptive) return;
    ewmaMs = updateEwma(ewmaMs, latencyMs);
    if (outcome.ok && warmupSuccesses < warmup) {
      warmupEwmaMs = updateEwma(warmupEwmaMs, latencyMs);
      warmupSuccesses += 1;
      if (warmupSuccesses >= warmup) baselineMs = warmupEwmaMs;
    }
    const unhealthy = !outcome.ok || (baselineMs !== undefined && ewmaMs > baselineMs * spikeFactor);
    if (unhealthy) {
      concurrency = Math.max(1, Math.floor(concurrency * decreaseFactor));
      intervalMs = Math.min(startIntervalMs, Math.max(intervalMs * 2, 250));
      if (outcome.retryAfterMs !== undefined) nextAllowed = Math.max(nextAllowed, now() + Math.max(0, outcome.retryAfterMs));
      healthyStreak = 0;
      return;
    }
    healthyStreak += 1;
    if (warmupSuccesses >= warmup && healthyStreak >= increaseAfter) {
      healthyStreak = 0;
      if (concurrency < maxConcurrency) concurrency += 1;
      else if (intervalMs > minIntervalMs) intervalMs = Math.max(minIntervalMs, Math.floor(intervalMs * 0.7));
    }
  };

  return {
    async run<T>(task: () => Promise<T>, classify: (result: T) => PacerOutcome): Promise<T> {
      await acquire();
      const startedAt = now();
      let result: T | undefined;
      let thrown: unknown;
      let didThrow = false;
      let outcome: PacerOutcome = { ok: false };
      try {
        result = await task();
        outcome = classify(result);
      } catch (error) {
        didThrow = true;
        thrown = error;
      } finally {
        adjust(outcome, Math.max(0, now() - startedAt));
        inFlight -= 1;
        drainSlotWaiters();
      }
      if (didThrow) throw thrown;
      return result as T;
    },
    stats: (): PacerStats => ({ intervalMs, concurrency, ...(baselineMs === undefined ? {} : { baselineMs }) }),
  };
}

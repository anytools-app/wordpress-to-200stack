import { describe, expect, it } from "vitest";

import { createPacer, parseRetryAfter } from "../src/core/pacer.js";

function clock(initial = 0): { now: () => number; sleep: (milliseconds: number) => Promise<void>; advance: (milliseconds: number) => void } {
  let value = initial;
  return {
    now: () => value,
    sleep: async (milliseconds) => { value += milliseconds; },
    advance: (milliseconds) => { value += milliseconds; },
  };
}

describe("adaptive request pacer", () => {
  it("ramps concurrency and then interval down to the configured ceiling", async () => {
    const time = clock();
    const pacer = createPacer({ maxConcurrency: 2, minIntervalMs: 50, startIntervalMs: 100, warmup: 2, increaseAfter: 1, now: time.now, sleep: time.sleep });
    for (let index = 0; index < 4; index += 1) await pacer.run(async () => "ok", () => ({ ok: true }));
    expect(pacer.stats()).toMatchObject({ concurrency: 2, intervalMs: 50, baselineMs: 0 });
  });

  it("holds the start interval during successful warmup measurements", async () => {
    const time = clock();
    const starts: number[] = [];
    const pacer = createPacer({ maxConcurrency: 2, minIntervalMs: 0, startIntervalMs: 100, warmup: 3, increaseAfter: 1, now: time.now, sleep: time.sleep });
    for (let index = 0; index < 3; index += 1) await pacer.run(async () => { starts.push(time.now()); return "ok"; }, () => ({ ok: true }));
    expect(starts).toEqual([0, 100, 200]);
    expect(pacer.stats()).toMatchObject({ intervalMs: 100, concurrency: 2, baselineMs: 0 });
  });

  it("backs off on 429 and honours Retry-After before another start", async () => {
    const time = clock();
    const starts: number[] = [];
    const pacer = createPacer({ maxConcurrency: 1, minIntervalMs: 100, startIntervalMs: 1000, warmup: 0, increaseAfter: 1, now: time.now, sleep: time.sleep });
    await pacer.run(async () => { starts.push(time.now()); return 200; }, () => ({ ok: true }));
    await pacer.run(async () => { starts.push(time.now()); return 200; }, () => ({ ok: true }));
    await pacer.run(async () => { starts.push(time.now()); return 429; }, () => ({ ok: false, retryAfterMs: 3000 }));
    expect(pacer.stats()).toMatchObject({ concurrency: 1, intervalMs: 978 });
    await pacer.run(async () => { starts.push(time.now()); return 200; }, () => ({ ok: true }));
    expect(starts).toEqual([0, 700, 1189, 4189]);
  });

  it("backs off when latency spikes above the established baseline", async () => {
    const time = clock();
    const pacer = createPacer({ maxConcurrency: 3, minIntervalMs: 100, startIntervalMs: 500, warmup: 2, increaseAfter: 1, spikeFactor: 2, now: time.now, sleep: time.sleep });
    for (let index = 0; index < 2; index += 1) await pacer.run(async () => { time.advance(10); return "ok"; }, () => ({ ok: true }));
    await pacer.run(async () => { time.advance(100); return "slow"; }, () => ({ ok: true }));
    expect(pacer.stats()).toMatchObject({ baselineMs: 10, concurrency: 1, intervalMs: 500 });
  });

  it("backs off and releases its slot when a network task throws", async () => {
    const time = clock();
    const pacer = createPacer({ maxConcurrency: 2, minIntervalMs: 100, startIntervalMs: 500, warmup: 0, increaseAfter: 1, now: time.now, sleep: time.sleep });
    await pacer.run(async () => "ok", () => ({ ok: true }));
    await expect(pacer.run(async () => { throw new Error("network failed"); }, () => ({ ok: true }))).rejects.toThrow("network failed");
    expect(pacer.stats()).toMatchObject({ concurrency: 1, intervalMs: 500 });
    await expect(pacer.run(async () => "recovered", () => ({ ok: true }))).resolves.toBe("recovered");
  });

  it("wakes queued slot waiters in FIFO order without polling sleep", async () => {
    const time = clock();
    const sleepCalls: number[] = [];
    const pacer = createPacer({ maxConcurrency: 1, minIntervalMs: 0, startIntervalMs: 0, adaptive: false, now: time.now, sleep: async (milliseconds) => { sleepCalls.push(milliseconds); } });
    const started: string[] = [];
    let releaseFirst: ((value: string) => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const first = pacer.run(async () => {
      started.push("first");
      firstStarted?.();
      return new Promise<string>((resolve) => { releaseFirst = resolve; });
    }, () => ({ ok: true }));
    await firstStartedPromise;
    const second = pacer.run(async () => { started.push("second"); return "second"; }, () => ({ ok: true }));
    const third = pacer.run(async () => { started.push("third"); return "third"; }, () => ({ ok: true }));
    await Promise.resolve();
    expect(sleepCalls).toEqual([]);
    releaseFirst?.("first");
    await expect(Promise.all([first, second, third])).resolves.toEqual(["first", "second", "third"]);
    expect(started).toEqual(["first", "second", "third"]);
  });

  it("allows media-style minIntervalMs=0 to remove spacing after ramp-up", async () => {
    const time = clock();
    const starts: number[] = [];
    const pacer = createPacer({ maxConcurrency: 1, minIntervalMs: 0, startIntervalMs: 2, warmup: 0, increaseAfter: 1, now: time.now, sleep: time.sleep });
    for (let index = 0; index < 4; index += 1) await pacer.run(async () => { starts.push(time.now()); return "ok"; }, () => ({ ok: true }));
    expect(pacer.stats()).toMatchObject({ intervalMs: 0, concurrency: 1 });
    expect(starts).toEqual([0, 1, 1, 1]);
  });

  it("uses the configured maximum immediately when adaptive mode is disabled", async () => {
    const time = clock();
    const starts: number[] = [];
    const pacer = createPacer({ maxConcurrency: 3, minIntervalMs: 0, startIntervalMs: 1000, adaptive: false, now: time.now, sleep: time.sleep });
    await Promise.all(Array.from({ length: 3 }, () => pacer.run(async () => { starts.push(time.now()); return "ok"; }, () => ({ ok: true }))));
    expect(pacer.stats()).toEqual({ intervalMs: 0, concurrency: 3 });
    expect(starts).toEqual([0, 0, 0]);
  });

  it("parses Retry-After seconds and HTTP-date values", () => {
    expect(parseRetryAfter("1.5", 0)).toBe(1500);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:02 GMT", 500)).toBe(1500);
    expect(parseRetryAfter("invalid", 0)).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  ALWAYS_READY,
  SCHEDULE_RETRY_DELAYS_MS,
  createDrainReadiness,
  scheduleWithRetry,
} from "./readiness";

describe("createDrainReadiness", () => {
  it("starts NOT scheduled (with no queue connection nothing would ever send) and follows the marks", () => {
    const r = createDrainReadiness();
    expect(r.drainScheduled()).toBe(false);
    r.markScheduled();
    expect(r.drainScheduled()).toBe(true);
    r.markNotScheduled();
    expect(r.drainScheduled()).toBe(false);
    expect(ALWAYS_READY.drainScheduled()).toBe(true);
  });
});

describe("scheduleWithRetry", () => {
  const harness = () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const readiness = createDrainReadiness();
    const failures: { attempt: number; next: number | null }[] = [];
    return {
      timers,
      readiness,
      failures,
      options: {
        onScheduled: () => readiness.markScheduled(),
        onFailure: (_e: unknown, attempt: number, next: number | null) => {
          readiness.markNotScheduled();
          failures.push({ attempt, next });
        },
        setTimer: (fn: () => void, ms: number) => {
          timers.push({ fn, ms });
        },
      },
    };
  };

  it("never throws: a first failure is reported, the flag stays false and a retry is armed", async () => {
    const h = harness();
    const schedule = vi.fn().mockRejectedValue(new Error("valkey down"));
    await expect(scheduleWithRetry({ schedule, ...h.options })).resolves.toBeUndefined();
    expect(h.readiness.drainScheduled()).toBe(false);
    expect(h.failures).toEqual([{ attempt: 1, next: SCHEDULE_RETRY_DELAYS_MS[0] }]);
    expect(h.timers.map((t) => t.ms)).toEqual([SCHEDULE_RETRY_DELAYS_MS[0]]);
  });

  it("retries with the bounded backoff and flips the flag the moment a retry succeeds", async () => {
    const h = harness();
    const schedule = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue([]);
    await scheduleWithRetry({ schedule, ...h.options });
    expect(h.readiness.drainScheduled()).toBe(false);
    h.timers.shift()?.fn(); // first retry fails again
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.timers).toHaveLength(1));
    expect(h.timers[0]?.ms).toBe(SCHEDULE_RETRY_DELAYS_MS[1]);
    h.timers.shift()?.fn(); // second retry succeeds
    await vi.waitFor(() => expect(h.readiness.drainScheduled()).toBe(true));
    expect(schedule).toHaveBeenCalledTimes(3);
    expect(h.timers).toHaveLength(0); // no further retry once scheduled
  });

  it("gives up after the bounded number of retries and stays not scheduled", async () => {
    const h = harness();
    const schedule = vi.fn().mockRejectedValue(new Error("down"));
    await scheduleWithRetry({ schedule, delaysMs: [1, 2], ...h.options });
    while (h.timers.length > 0) {
      h.timers.shift()?.fn();
      await new Promise((r) => setImmediate(r));
    }
    expect(schedule).toHaveBeenCalledTimes(3); // the first try and two retries
    expect(h.failures.at(-1)).toEqual({ attempt: 3, next: null });
    expect(h.readiness.drainScheduled()).toBe(false);
  });

  it("is ready at once when the first attempt succeeds", async () => {
    const h = harness();
    await scheduleWithRetry({ schedule: async () => [], ...h.options });
    expect(h.readiness.drainScheduled()).toBe(true);
    expect(h.timers).toHaveLength(0);
  });
});

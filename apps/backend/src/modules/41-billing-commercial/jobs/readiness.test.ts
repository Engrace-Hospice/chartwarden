import { describe, expect, it, vi } from "vitest";
import { M41_CRON_QUEUES, M41_JOB_SCHEDULES } from "./queues";
import {
  ALWAYS_READY,
  SCHEDULE_RETRY_DELAYS_MS,
  createDrainReadiness,
  createSharedDrainReadiness,
  scheduleWithRetry,
} from "./readiness";
import { createScheduleProbe } from "./schedule-probe";

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

describe("createSharedDrainReadiness (the API process of a split deployment)", () => {
  const harness = (probeAnswers: (boolean | Error)[]) => {
    let clock = 0;
    const probe = vi.fn(async () => {
      const a = probeAnswers.shift();
      if (a instanceof Error) throw a;
      return a ?? false;
    });
    const local = createDrainReadiness();
    const readiness = createSharedDrainReadiness({
      local,
      probe,
      now: () => clock,
      ttlMs: 20_000,
      negativeTtlMs: 5_000,
    });
    return {
      probe,
      local,
      readiness,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  };

  it("is ready from shared state alone: the API never registers anything, yet serves once the schedules exist", async () => {
    const h = harness([true]);
    expect(h.local.drainScheduled()).toBe(false); // this process never marks itself
    await expect(h.readiness.drainScheduled()).resolves.toBe(true);
  });

  it("is not ready while the schedules are absent, and notices them within the short negative window", async () => {
    const h = harness([false, true]);
    await expect(h.readiness.drainScheduled()).resolves.toBe(false);
    h.advance(1_000);
    await expect(h.readiness.drainScheduled()).resolves.toBe(false); // cached, no second probe
    expect(h.probe).toHaveBeenCalledTimes(1);
    h.advance(5_000);
    await expect(h.readiness.drainScheduled()).resolves.toBe(true);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it("caches a positive answer for the long window, then asks again", async () => {
    const h = harness([true, false]);
    await h.readiness.drainScheduled();
    h.advance(19_000);
    await expect(h.readiness.drainScheduled()).resolves.toBe(true);
    expect(h.probe).toHaveBeenCalledTimes(1);
    h.advance(2_000);
    await expect(h.readiness.drainScheduled()).resolves.toBe(false);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the probe faults", async () => {
    const h = harness([new Error("valkey down")]);
    await expect(h.readiness.drainScheduled()).resolves.toBe(false);
  });

  it("with no probe (no queue connection at all) only this process' own registration can make it ready", async () => {
    const local = createDrainReadiness();
    const readiness = createSharedDrainReadiness({ local });
    await expect(readiness.drainScheduled()).resolves.toBe(false);
    local.markScheduled();
    await expect(readiness.drainScheduled()).resolves.toBe(true);
  });

  it("this process' own registration short-circuits the probe", async () => {
    const h = harness([false]);
    h.local.markScheduled();
    await expect(h.readiness.drainScheduled()).resolves.toBe(true);
    expect(h.probe).not.toHaveBeenCalled();
  });
});

describe("createScheduleProbe", () => {
  const both = {
    [M41_CRON_QUEUES.submissionDrain]: [M41_JOB_SCHEDULES.submissionDrain],
    [M41_CRON_QUEUES.ackPull]: [M41_JOB_SCHEDULES.ackPull],
  };
  const probeOf = (present: Record<string, string[]>, fail = false) =>
    createScheduleProbe({
      connection: {},
      makeQueue: (name) => ({
        getRepeatableJobs: async () => {
          if (fail) throw new Error("valkey down");
          return (present[name] ?? []).map((pattern) => ({ pattern }));
        },
        close: async () => undefined,
      }),
    });

  it("is true only when BOTH repeatable schedules exist with the expected patterns", async () => {
    await expect(probeOf(both)()).resolves.toBe(true);
    await expect(
      probeOf({ [M41_CRON_QUEUES.submissionDrain]: [M41_JOB_SCHEDULES.submissionDrain] })(),
    ).resolves.toBe(false);
    await expect(probeOf({ ...both, [M41_CRON_QUEUES.ackPull]: ["0 0 * * *"] })()).resolves.toBe(
      false,
    );
    await expect(probeOf({})()).resolves.toBe(false);
  });

  it("rejects when the store faults (the readiness treats that as not scheduled)", async () => {
    await expect(probeOf({}, true)()).rejects.toThrow(/valkey down/);
  });

  describe("during a Valkey outage (the client retries forever and never answers)", () => {
    const hanging = () => {
      const made: { closed: boolean }[] = [];
      const probe = createScheduleProbe({
        connection: {},
        timeoutMs: 2_000,
        makeQueue: () => {
          const q = { closed: false };
          made.push(q);
          return {
            getRepeatableJobs: () => new Promise<never>(() => undefined), // never settles
            close: async () => {
              q.closed = true;
            },
          };
        },
      });
      return { probe, made };
    };

    it("times out instead of hanging, drops the failed queue and builds a new one on the next probe", async () => {
      vi.useFakeTimers();
      try {
        const { probe, made } = hanging();
        const first = expect(probe()).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(2_000);
        await first;
        expect(made).toHaveLength(1);
        expect(made[0]?.closed).toBe(true); // the failed one is discarded, never cached forever
        const second = expect(probe()).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(2_000);
        await second;
        expect(made).toHaveLength(2); // a fresh queue for the retry
      } finally {
        vi.useRealTimers();
      }
    });

    it("the shared readiness answers false after the timeout and caches that, so requests do not pile up on a dead store", async () => {
      vi.useFakeTimers();
      try {
        const { probe } = hanging();
        const calls = vi.fn(probe);
        const readiness = createSharedDrainReadiness({
          local: createDrainReadiness(),
          probe: calls,
          negativeTtlMs: 5_000,
        });
        // three concurrent requests share ONE in-flight probe
        const answers = Promise.all([
          readiness.drainScheduled(),
          readiness.drainScheduled(),
          readiness.drainScheduled(),
        ]);
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(answers).resolves.toEqual([false, false, false]);
        expect(calls).toHaveBeenCalledTimes(1);
        // inside the negative window the next request is answered from the cache, with no new probe
        await expect(readiness.drainScheduled()).resolves.toBe(false);
        expect(calls).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

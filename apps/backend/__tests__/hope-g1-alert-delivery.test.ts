import type { DbClient } from "@chartwarden/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Alert delivery's failure paths that the breaker and the abandoned-emit cap add (no live infrastructure):
//  - three alerts in a row that fail must not hide the alerts behind them when the emitter is up (a poisoned payload),
//    and must still stop the org when the emitter is down;
//  - timed-out emits keep running, so a bounded number of them stops further emitting until they settle, and the tick
//    reports that as a failure instead of skipping silently.
const store = vi.hoisted(() => ({
  openHopeSchedulesForOrg: vi.fn(),
  openOrOverdueSfvsForOrg: vi.fn(),
  recentlyExpiredSchedulesForOrg: vi.fn(),
  sfvsToReplayAlertsForOrg: vi.fn(),
  updateHopeScheduleStatus: vi.fn(),
  updateSfvStatus: vi.fn(),
}));
vi.mock("../src/modules/10-hope/jobs/cron-store", () => store);

import {
  type deliverAlerts as DeliverAlerts,
  M10_ALERT_EMIT_TIMEOUT_MS,
  M10_ALERT_MAX_ABANDONED_EMITS,
  M10_ALERT_MAX_CONSECUTIVE_FAILURES,
  type PlannedM10AlertEmission,
} from "../src/modules/10-hope/jobs/watchdog-alerts";
import type { runSfvWatchdogTick as RunSfvWatchdogTick } from "../src/modules/10-hope/jobs/watchdog-ticks";

// `watchdog-alerts` counts timed-out emits that are still running in module-level state with no reset. Each test loads a
// FRESH copy of the module (vi.resetModules in beforeEach), so a test that leaves emits hanging, or fails before it frees
// them, cannot starve the next test. The constants above are plain values and identical in every copy.
let deliverAlerts: typeof DeliverAlerts;
let runSfvWatchdogTick: typeof RunSfvWatchdogTick;

const ORG_A = "11111111-1111-4111-8111-111111111111";
const PATIENT = "99999999-9999-4999-8999-999999999999";
const SFV_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const NOW = new Date("2030-06-01T00:00:00.000Z");
const ANSWER = { alertId: "a", resolvedRecipientCount: 1 };

const alertsOf = (count: number): PlannedM10AlertEmission[] =>
  Array.from({ length: count }, (_, i) => ({
    eventType: "m10.hope.sfv_overdue" as const,
    severity: "critical" as const,
    correlationId: `c${i + 1}`,
    payload: {},
  }));

const loggedErrors = (spy: { mock: { calls: readonly unknown[][] } }): string =>
  spy.mock.calls.map((call) => String(call[0])).join("\n");

/** An emitter that fails exactly the alerts whose correlation id is in `failing`, and records the order it was called in. */
const emitterFailing = (failing: readonly string[]) =>
  vi.fn(async (_org: string, alert: { correlationId: string }) => {
    if (failing.includes(alert.correlationId)) throw new Error("emit failed");
    return ANSWER;
  });
const order = (emit: { mock: { calls: readonly unknown[][] } }): string[] =>
  emit.mock.calls.map((c) => (c[1] as { correlationId: string }).correlationId);

let errors: { mock: { calls: readonly unknown[][] } };
beforeEach(async () => {
  vi.resetModules();
  ({ deliverAlerts } = await import("../src/modules/10-hope/jobs/watchdog-alerts"));
  ({ runSfvWatchdogTick } = await import("../src/modules/10-hope/jobs/watchdog-ticks"));
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("deliverAlerts — a poisoned head of the list is not an outage", () => {
  it(`${M10_ALERT_MAX_CONSECUTIVE_FAILURES} failing alerts at the head do not starve the ones behind them when the last alert still answers`, async () => {
    const emit = emitterFailing(["c1", "c2", "c3"]);

    const result = await deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(6));

    // c1-c3 fail, c6 is the probe and answers, then c4 and c5 are attempted: every alert exactly once.
    expect(order(emit)).toEqual(["c1", "c2", "c3", "c6", "c4", "c5"]);
    expect(result).toMatchObject({ failed: 3, skipped: 0 });
    expect(loggedErrors(errors)).toContain("the last alert answered");
  });

  it("a down emitter still stops the org: the probe of the last alert fails too, and the alerts between wait for the next tick", async () => {
    const emit = emitterFailing(["c1", "c2", "c3", "c6"]);

    const result = await deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(6));

    expect(order(emit)).toEqual(["c1", "c2", "c3", "c6"]);
    expect(result).toMatchObject({ failed: 4, skipped: 2 });
    expect(loggedErrors(errors)).toContain("2 remaining alert(s) skipped until the next tick");
  });

  it("when the last alert is the only one left it is emitted once (as the probe), never twice", async () => {
    const emit = emitterFailing(["c1", "c2", "c3", "c4"]);

    const result = await deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(4));

    expect(order(emit)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(result).toMatchObject({ failed: 4, skipped: 0 });
  });

  // Deliberate (a trade-off, not an oversight): the alert order never changes between ticks, so a second breaker after the probe
  // would starve the alerts behind a run of poisoned ones on EVERY tick, and a missed critical alert is worse than a slow tick.
  // What bounds the cost of per-alert failures is the abandoned-emit cap (see the next describe), which covers emits that HANG;
  // an emit that throws slowly is not capped (the header of watchdog-alerts.ts says so).
  it("once the probe answered, later failures do not trip the breaker again: every alert is attempted exactly once", async () => {
    const emit = emitterFailing(["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);

    const result = await deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(8));

    expect(order(emit)).toEqual(["c1", "c2", "c3", "c8", "c4", "c5", "c6", "c7"]);
    expect(result).toMatchObject({ failed: 7, skipped: 0 });
  });

  it("keeps the first error for the tick's aggregate failure when the probe is what saved the rest", async () => {
    const first = new Error("poisoned");
    const emit = vi.fn(async (_org: string, alert: { correlationId: string }) => {
      if (alert.correlationId === "c1") throw first;
      if (["c2", "c3"].includes(alert.correlationId)) throw new Error("later");
      return ANSWER;
    });

    const result = await deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(5));

    expect(result.firstError).toBe(first);
  });
});

describe("deliverAlerts — timed-out emits that are still running are capped", () => {
  /** An emitter whose emits never answer until `settleAll()`; every call is recorded. */
  function hangingEmitter() {
    const settlers: Array<() => void> = [];
    const emit = vi.fn(
      () =>
        new Promise<typeof ANSWER>((resolve) => {
          settlers.push(() => resolve(ANSWER));
        }),
    );
    return {
      emit,
      settleAll: async () => {
        for (const settle of settlers.splice(0)) settle();
        await vi.advanceTimersByTimeAsync(0);
      },
    };
  }

  /** One org, one alert, run to its deadline. */
  async function timeOutOneEmit(emitter: { emit: ReturnType<typeof hangingEmitter>["emit"] }) {
    const run = deliverAlerts(emitter, ORG_A, "sfv-watchdog", alertsOf(1));
    await vi.advanceTimersByTimeAsync(M10_ALERT_EMIT_TIMEOUT_MS);
    return run;
  }

  it(`emits nothing once ${M10_ALERT_MAX_ABANDONED_EMITS} timed-out emits are still running, names the org, and resumes when they settle`, async () => {
    vi.useFakeTimers();
    const hanging = hangingEmitter();
    for (let i = 0; i < M10_ALERT_MAX_ABANDONED_EMITS; i += 1) {
      expect(await timeOutOneEmit(hanging)).toMatchObject({ failed: 1, skipped: 0 });
    }
    expect(hanging.emit).toHaveBeenCalledTimes(M10_ALERT_MAX_ABANDONED_EMITS);

    const blocked = await deliverAlerts(hanging, ORG_A, "sfv-watchdog", alertsOf(3));

    expect(hanging.emit).toHaveBeenCalledTimes(M10_ALERT_MAX_ABANDONED_EMITS); // nothing new was emitted
    expect(blocked).toMatchObject({ failed: 0, skipped: 3 });
    expect(blocked.firstError).toMatchObject({ name: "AlertEmitBackpressureError" });
    const logged = loggedErrors(errors);
    expect(logged).toContain(ORG_A);
    expect(logged).toContain("still running");

    await hanging.settleAll(); // the abandoned emits finish: their slots are free again
    const emit = emitterFailing([]);
    await expect(deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(2))).resolves.toEqual({
      failed: 0,
      skipped: 0,
    });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it(`${M10_ALERT_MAX_ABANDONED_EMITS} emits still in flight but inside their deadline are not abandoned: the next delivery still emits`, async () => {
    vi.useFakeTimers();
    const slow = hangingEmitter();
    // Six deliveries of ONE org, each with its emit started and none timed out (the clock stays inside the deadline).
    const inFlight = Array.from({ length: M10_ALERT_MAX_ABANDONED_EMITS }, () =>
      deliverAlerts(slow, ORG_A, "sfv-watchdog", alertsOf(1)),
    );
    await vi.advanceTimersByTimeAsync(M10_ALERT_EMIT_TIMEOUT_MS - 1);
    expect(slow.emit).toHaveBeenCalledTimes(M10_ALERT_MAX_ABANDONED_EMITS);

    const next = emitterFailing([]);
    const result = await deliverAlerts({ emit: next }, ORG_A, "sfv-watchdog", alertsOf(2));

    expect(next).toHaveBeenCalledTimes(2); // not blocked by the cap: only a TIMED-OUT emit counts toward it
    expect(result).toEqual({ failed: 0, skipped: 0 });
    await slow.settleAll(); // they answer inside the deadline
    await expect(Promise.all(inFlight)).resolves.toEqual(
      inFlight.map(() => ({ failed: 0, skipped: 0 })),
    );
  });

  // The next two tests are an ordered pair: the first leaves the cap exhausted (its hung emits never settle), the second must
  // not inherit that. Without the fresh module copy per test the second one is blocked as backpressure.
  it("(isolation, part 1) leaves every abandoned-emit slot taken on purpose", async () => {
    vi.useFakeTimers();
    const hanging = hangingEmitter();
    for (let i = 0; i < M10_ALERT_MAX_ABANDONED_EMITS; i += 1) await timeOutOneEmit(hanging);

    const blocked = await deliverAlerts(hanging, ORG_A, "sfv-watchdog", alertsOf(1));

    expect(blocked).toMatchObject({ failed: 0, skipped: 1 });
  });

  it("(isolation, part 2) the previous test's abandoned emits do not count here", async () => {
    const emit = emitterFailing([]);

    await expect(deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(1))).resolves.toEqual({
      failed: 0,
      skipped: 0,
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("the tick counts an org whose alerts were not emitted as failed, so the job fails and the DLQ alert fires", async () => {
    vi.useFakeTimers();
    const hanging = hangingEmitter();
    for (let i = 0; i < M10_ALERT_MAX_ABANDONED_EMITS; i += 1) await timeOutOneEmit(hanging);
    const calledBefore = hanging.emit.mock.calls.length;
    for (const fn of Object.values(store)) fn.mockReset();
    store.openOrOverdueSfvsForOrg.mockResolvedValue([]);
    store.sfvsToReplayAlertsForOrg.mockResolvedValue([
      {
        sfvId: SFV_1,
        patientId: PATIENT,
        admissionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        triggeringAssessmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        status: "overdue" as const,
        dueAt: "2030-05-31T00:00:00.000Z",
        timeZone: "America/Los_Angeles",
      },
    ]);
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: async () => undefined }),
    } as unknown as DbClient;

    await expect(
      runSfvWatchdogTick({
        db,
        outbox: { publish: vi.fn(async () => undefined) },
        alerts: hanging,
        now: NOW,
        systemUserId: "",
        organizationIds: [ORG_A],
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/failed for 1 of 1 org/),
      cause: expect.objectContaining({ name: "AlertEmitBackpressureError" }),
    });
    expect(hanging.emit).toHaveBeenCalledTimes(calledBefore);

    await hanging.settleAll();
  });
});

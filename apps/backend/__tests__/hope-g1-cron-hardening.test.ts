import type { DbClient } from "@chartwarden/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The failure paths of M10's background jobs, with the stores and the database faked (no live infrastructure):
//  - an alert emit that hangs or fails is bounded, and one poisoned alert does not hide the org's later alerts;
//  - every cron transaction bounds its lock wait first, so one blocked write fails that org instead of the whole job;
//  - one org failing does not starve the orgs after it (the monthly retention scan, and the batch-list reads of the two
//    unscheduled iQIES workers), and the failing org is named in the log.
const store = vi.hoisted(() => ({
  openHopeSchedulesForOrg: vi.fn(),
  openOrOverdueSfvsForOrg: vi.fn(),
  recentlyExpiredSchedulesForOrg: vi.fn(),
  sfvsToReplayAlertsForOrg: vi.fn(),
  updateHopeScheduleStatus: vi.fn(),
  updateSfvStatus: vi.fn(),
}));
vi.mock("../src/modules/10-hope/jobs/cron-store", () => store);
const retentionStore = vi.hoisted(() => ({
  hopeRetentionFactsForOrg: vi.fn(),
  insertRetentionReview: vi.fn(),
  retentionReviewsForOrg: vi.fn(),
  updateRetentionReview: vi.fn(),
}));
vi.mock("../src/modules/10-hope/jobs/retention-store", () => retentionStore);
const assembleStore = vi.hoisted(() => ({
  assemblableAssessmentsForOrg: vi.fn(),
  persistAssembledSubmission: vi.fn(),
}));
vi.mock("../src/modules/10-hope/jobs/assemble-store", () => assembleStore);
const submissionStore = vi.hoisted(() => ({
  applyItemTransition: vi.fn(),
  claimSubmissionForTransmit: vi.fn(),
  inFlightSubmissionsForOrg: vi.fn(),
  lockInFlightSubmission: vi.fn(),
  pendingItemsForSubmission: vi.fn(),
  queuedSubmissionsForOrg: vi.fn(),
  recordReconcileOutcome: vi.fn(),
  recordTransmit: vi.fn(),
  releaseSubmission: vi.fn(),
  writeValidationFindings: vi.fn(),
}));
vi.mock("../src/modules/10-hope/jobs/submission-store", () => submissionStore);

import { M10_LOCK_TIMEOUT_MS } from "../src/modules/10-hope/hope-assessment-lock";
import type {
  M10WorkerDeps,
  runAssembleSubmissionCron as RunAssembleSubmissionCron,
  runHopeRetentionCron as RunHopeRetentionCron,
  runIqiesReconcileCron as RunIqiesReconcileCron,
  runIqiesSubmitCron as RunIqiesSubmitCron,
} from "../src/modules/10-hope/jobs/cron-workers";
import {
  type deliverAlerts as DeliverAlerts,
  M10_ALERT_EMIT_TIMEOUT_MS,
  M10_ALERT_MAX_ABANDONED_EMITS,
  M10_ALERT_MAX_CONSECUTIVE_FAILURES,
  type PlannedM10AlertEmission,
} from "../src/modules/10-hope/jobs/watchdog-alerts";
import type {
  runSfvWatchdogTick as RunSfvWatchdogTick,
  runWindowWatchdogTick as RunWindowWatchdogTick,
  WatchdogTickDeps,
} from "../src/modules/10-hope/jobs/watchdog-ticks";

// `watchdog-alerts` counts timed-out emits that are still running in module-level state with no reset, per org and per
// process. Each test loads a FRESH copy of the job modules (vi.resetModules in beforeEach, one graph for all of them), so a
// test that leaves emits hanging, or fails before it frees them, cannot starve the next test. The constants above are plain
// values and identical in every copy.
let deliverAlerts: typeof DeliverAlerts;
let runSfvWatchdogTick: typeof RunSfvWatchdogTick;
let runWindowWatchdogTick: typeof RunWindowWatchdogTick;
let runAssembleSubmissionCron: typeof RunAssembleSubmissionCron;
let runHopeRetentionCron: typeof RunHopeRetentionCron;
let runIqiesReconcileCron: typeof RunIqiesReconcileCron;
let runIqiesSubmitCron: typeof RunIqiesSubmitCron;

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const SFV_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PATIENT = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2030-06-01T00:00:00.000Z");
const SECRET = "secret value";

/** A node-postgres-shaped failure: named "error", with the SQLSTATE and a message that carries a value. */
function pgError(code: string): Error {
  const driver = Object.assign(new Error(`failed for patient ${PATIENT} ${SECRET}`), {
    code,
    name: "error",
  });
  return new Error("Failed query", { cause: driver });
}

/** Everything a spied `console.error` was called with, as one string. */
const loggedErrors = (spy: { mock: { calls: readonly unknown[][] } }): string =>
  spy.mock.calls.map((call) => String(call[0])).join("\n");

/** What the fake transaction ran, in order: the statements the cron issued itself and the store reads it faked. */
let order: string[] = [];
const dialect = new PgDialect();
const fakeDb = {
  transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        const { sql, params } = dialect.sqlToQuery(query);
        if (/app\.(org|user)_id/.test(sql)) return; // the tenancy envelope's own statements, not the cron's
        order.push(`exec: ${sql} [${params.join(",")}]`);
      },
    }),
} as unknown as DbClient;

const LOCK_BOUND = `exec: SELECT set_config('lock_timeout', $1, true) [${M10_LOCK_TIMEOUT_MS}ms]`;

const alertsOf = (count: number): PlannedM10AlertEmission[] =>
  Array.from({ length: count }, (_, i) => ({
    eventType: "m10.hope.sfv_overdue" as const,
    severity: "critical" as const,
    correlationId: `c${i + 1}`,
    payload: {},
  }));

const overdueSfv = (sfvId: string) => ({
  sfvId,
  patientId: PATIENT,
  admissionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  triggeringAssessmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  status: "overdue" as const,
  dueAt: "2030-05-31T00:00:00.000Z",
  timeZone: "America/Los_Angeles",
});

let errors: { mock: { calls: readonly unknown[][] } };
beforeEach(async () => {
  vi.resetModules();
  ({ deliverAlerts } = await import("../src/modules/10-hope/jobs/watchdog-alerts"));
  ({ runSfvWatchdogTick, runWindowWatchdogTick } = await import(
    "../src/modules/10-hope/jobs/watchdog-ticks"
  ));
  ({ runAssembleSubmissionCron, runHopeRetentionCron, runIqiesReconcileCron, runIqiesSubmitCron } =
    await import("../src/modules/10-hope/jobs/cron-workers"));
  order = [];
  for (const group of [store, retentionStore, assembleStore, submissionStore]) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("deliverAlerts — a poisoned alert, a hung emit", () => {
  it("emits the alerts AFTER a failed one: only that alert fails", async () => {
    const failure = pgError("22P02");
    const emit = vi.fn(async (_org: string, alert: { correlationId: string }) => {
      if (alert.correlationId === "c2") throw failure;
      return { alertId: "a", resolvedRecipientCount: 1 };
    });

    const result = await deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(4));

    expect(emit.mock.calls.map((c) => c[1].correlationId)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(result).toEqual({ failed: 1, skipped: 0, firstError: failure });
    const logged = loggedErrors(errors);
    expect(logged).toContain("c2");
    expect(logged).toContain(ORG_A);
    expect(logged).toContain("SQLSTATE 22P02");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PATIENT);
  });

  it(`stops the org after ${M10_ALERT_MAX_CONSECUTIVE_FAILURES} failures IN A ROW and a failed probe of the last alert, and says how many alerts wait for the next tick`, async () => {
    const emit = vi.fn(async (_org: string, _alert: { correlationId: string }) => {
      throw pgError("55P03");
    });

    const result = await deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(5));

    // Three in a row, then the LAST alert (c5) once, as the probe that tells a down emitter from poisoned alerts.
    expect(emit.mock.calls.map((c) => c[1].correlationId)).toEqual(["c1", "c2", "c3", "c5"]);
    expect(result).toMatchObject({ failed: 4, skipped: 1 });
    expect(loggedErrors(errors)).toContain("1 remaining alert(s) skipped until the next tick");
  });

  it("a success resets the count: failures that are not consecutive never stop the org", async () => {
    const outcomes = ["fail", "fail", "ok", "fail", "fail", "ok"];
    const emit = vi.fn(async () => {
      if (outcomes.shift() === "fail") throw new Error("down");
      return { alertId: "a", resolvedRecipientCount: 1 };
    });

    const result = await deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(6));

    expect(emit).toHaveBeenCalledTimes(6);
    expect(result).toMatchObject({ failed: 4, skipped: 0 });
  });

  it("gives up on an emit that never answers, counts it failed, and still emits the next alert", async () => {
    vi.useFakeTimers();
    const emit = vi.fn(async (_org: string, alert: { correlationId: string }) =>
      alert.correlationId === "c1"
        ? new Promise<never>(() => {}) // never settles
        : { alertId: "a", resolvedRecipientCount: 1 },
    );

    const run = deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(2));
    await vi.advanceTimersByTimeAsync(M10_ALERT_EMIT_TIMEOUT_MS);
    const result = await run;

    expect(emit).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ failed: 1, skipped: 0 });
    expect(result.firstError).toMatchObject({ name: "AlertEmitTimeoutError" });
    expect(loggedErrors(errors)).toContain("AlertEmitTimeoutError");
    expect(vi.getTimerCount()).toBe(0); // no timer is left behind
  });

  // An ordered pair: part 1 leaves org A's abandoned-emit slots all taken (its hung emits never settle), part 2 must not
  // inherit that. Without a fresh module copy per test, part 2 is refused as backpressure.
  it("(isolation, part 1) leaves every abandoned-emit slot of org A taken on purpose", async () => {
    vi.useFakeTimers();
    const hang = vi.fn((_org: string, _alert: unknown) => new Promise<never>(() => {}));
    for (let i = 0; i < M10_ALERT_MAX_ABANDONED_EMITS; i += 1) {
      const run = deliverAlerts({ emit: hang }, ORG_A, "sfv-watchdog", alertsOf(1));
      await vi.advanceTimersByTimeAsync(M10_ALERT_EMIT_TIMEOUT_MS);
      await run;
    }

    const blocked = await deliverAlerts({ emit: hang }, ORG_A, "sfv-watchdog", alertsOf(1));

    expect(blocked).toMatchObject({ failed: 0, skipped: 1 });
  });

  it("(isolation, part 2) the previous test's abandoned emits do not count here", async () => {
    const emit = vi.fn(async () => ({ alertId: "a", resolvedRecipientCount: 1 }));

    await expect(deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(1))).resolves.toEqual({
      failed: 0,
      skipped: 0,
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("an emit that rejects AFTER its deadline, or throws synchronously, leaves no unhandled rejection and no timer", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const emit = vi.fn((_org: string, alert: { correlationId: string }) => {
        if (alert.correlationId === "c2") throw new Error("sync failure");
        return new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("late failure")), M10_ALERT_EMIT_TIMEOUT_MS * 2);
        });
      });

      const run = deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(2));
      await vi.advanceTimersByTimeAsync(M10_ALERT_EMIT_TIMEOUT_MS * 3);
      const result = await run;
      await vi.advanceTimersByTimeAsync(M10_ALERT_EMIT_TIMEOUT_MS * 3); // the late rejection lands here
      await Promise.resolve();

      expect(result).toMatchObject({ failed: 2, skipped: 0 });
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("logs a zero-recipient emit with the alert id and says the count is today's, not the stored alert's", async () => {
    const emit = vi.fn(async () => ({ alertId: "alert-id-0001", resolvedRecipientCount: 0 }));

    const result = await deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alertsOf(1));

    expect(result).toEqual({ failed: 0, skipped: 0 });
    const logged = loggedErrors(errors);
    expect(logged).toContain("alert-id-0001");
    expect(logged).toContain("today's count, not a record of who the stored alert reached");
    expect(logged).not.toContain("reached 0 recipients");
  });
});

describe("the watchdog ticks bound their waits", () => {
  const depsOf = (over: Partial<WatchdogTickDeps>): WatchdogTickDeps => ({
    db: fakeDb,
    outbox: { publish: vi.fn(async () => undefined) },
    now: NOW,
    systemUserId: "",
    organizationIds: [ORG_A],
    ...over,
  });

  it("the SFV tick's transaction bounds its lock wait BEFORE it reads or writes", async () => {
    store.openOrOverdueSfvsForOrg.mockImplementation(async () => {
      order.push("read");
      return [];
    });
    store.sfvsToReplayAlertsForOrg.mockResolvedValue([]);

    await runSfvWatchdogTick(depsOf({}));

    expect(order[0]).toBe(LOCK_BOUND);
    expect(order[1]).toBe("read");
  });

  it("the window tick's transaction bounds its lock wait BEFORE it reads or writes", async () => {
    store.openHopeSchedulesForOrg.mockImplementation(async () => {
      order.push("read");
      return [];
    });

    await runWindowWatchdogTick(depsOf({}));

    expect(order[0]).toBe(LOCK_BOUND);
    expect(order[1]).toBe("read");
  });

  it("an org whose write times out on a lock (55P03) is logged and counted, and the later org is still ticked", async () => {
    store.openOrOverdueSfvsForOrg.mockImplementation(async (_tx: unknown, org: string) => {
      if (org === ORG_A) throw pgError("55P03");
      return [];
    });
    store.sfvsToReplayAlertsForOrg.mockResolvedValue([]);

    await expect(runSfvWatchdogTick(depsOf({ organizationIds: [ORG_A, ORG_B] }))).rejects.toThrow(
      /failed for 1 of 2 org/,
    );

    expect(store.openOrOverdueSfvsForOrg.mock.calls.map((c) => c[1])).toEqual([ORG_A, ORG_B]);
    const logged = loggedErrors(errors);
    expect(logged).toContain(ORG_A);
    expect(logged).toContain("SQLSTATE 55P03");
    expect(logged).not.toContain(SECRET);
  });

  it("an emit that never answers fails ITS org after the deadline and does not starve the next org", async () => {
    vi.useFakeTimers();
    store.openOrOverdueSfvsForOrg.mockResolvedValue([]);
    store.sfvsToReplayAlertsForOrg.mockResolvedValue([overdueSfv(SFV_1)]);
    const emit = vi.fn(async (org: string, _alert: unknown) =>
      org === ORG_A
        ? new Promise<never>(() => {}) // org A's emitter hangs
        : { alertId: "a", resolvedRecipientCount: 1 },
    );

    const run = runSfvWatchdogTick(depsOf({ organizationIds: [ORG_A, ORG_B], alerts: { emit } }));
    const settled = expect(run).rejects.toThrow(/failed for 1 of 2 org/);
    await vi.advanceTimersByTimeAsync(
      M10_ALERT_EMIT_TIMEOUT_MS * M10_ALERT_MAX_CONSECUTIVE_FAILURES,
    );
    await settled;

    expect(emit.mock.calls.map((c) => c[0])).toEqual([ORG_A, ORG_B]);
  });
});

describe("the cron runners isolate one failing org from the rest", () => {
  const NOT_USED = {} as never;
  const baseDeps = (over: Partial<M10WorkerDeps> = {}): M10WorkerDeps => ({
    connection: NOT_USED,
    db: fakeDb,
    outbox: { publish: vi.fn(async () => undefined) },
    activeOrgs: {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    },
    retentionHolds: {
      activeLegalHoldScopeForOrg: async () => ({ orgWide: false, patientIds: new Set<string>() }),
    },
    now: () => NOW,
    ...over,
  });

  it("the retention scan: org A failing in its transaction does not stop org B; one AggregateError names no values", async () => {
    const failure = pgError("40P01");
    retentionStore.hopeRetentionFactsForOrg.mockImplementation(
      async (_tx: unknown, org: string) => {
        if (org === ORG_A) throw failure;
        return [];
      },
    );
    retentionStore.retentionReviewsForOrg.mockResolvedValue([]);

    const outcome = runHopeRetentionCron(baseDeps());

    await expect(outcome).rejects.toBeInstanceOf(AggregateError);
    await expect(outcome).rejects.toMatchObject({
      errors: [failure],
      message: expect.stringMatching(/1 organization\(s\) failed/),
    });
    expect(retentionStore.hopeRetentionFactsForOrg.mock.calls.map((c) => c[1])).toEqual([
      ORG_A,
      ORG_B,
    ]);
    const logged = loggedErrors(errors);
    expect(logged).toContain("hope-retention-scan");
    expect(logged).toContain(ORG_A);
    expect(logged).toContain("SQLSTATE 40P01");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PATIENT);
  });

  it("the retention scan: a legal-hold read that throws for org A does not stop org B", async () => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([]);
    retentionStore.retentionReviewsForOrg.mockResolvedValue([]);
    const activeLegalHoldScopeForOrg = vi.fn(async (org: string) => {
      if (org === ORG_A) throw new Error("hold seam down");
      return { orgWide: false, patientIds: new Set<string>() };
    });

    await expect(
      runHopeRetentionCron(baseDeps({ retentionHolds: { activeLegalHoldScopeForOrg } })),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(activeLegalHoldScopeForOrg.mock.calls.map((c) => c[0])).toEqual([ORG_A, ORG_B]);
    expect(retentionStore.hopeRetentionFactsForOrg.mock.calls.map((c) => c[1])).toEqual([ORG_B]);
  });

  it("the retention scan resolves when every org succeeds, and bounds each transaction's lock wait first", async () => {
    retentionStore.hopeRetentionFactsForOrg.mockImplementation(async () => {
      order.push("read");
      return [];
    });
    retentionStore.retentionReviewsForOrg.mockResolvedValue([]);

    await expect(runHopeRetentionCron(baseDeps())).resolves.toBeUndefined();

    expect(order).toEqual([LOCK_BOUND, "read", LOCK_BOUND, "read"]);
  });

  it("the assemble cron names the failing org in the log (the AggregateError's message names none)", async () => {
    assembleStore.assemblableAssessmentsForOrg.mockImplementation(
      async (_tx: unknown, org: string) => {
        if (org === ORG_A) throw pgError("55P03");
        return { eligible: [], unsitedAssessmentIds: [] };
      },
    );

    await expect(runAssembleSubmissionCron(baseDeps())).rejects.toBeInstanceOf(AggregateError);

    expect(assembleStore.assemblableAssessmentsForOrg.mock.calls.map((c) => c[1])).toEqual([
      ORG_A,
      ORG_B,
    ]);
    const logged = loggedErrors(errors);
    expect(logged).toContain("assemble-hope-submission");
    expect(logged).toContain(ORG_A);
    expect(logged).toContain("SQLSTATE 55P03");
    expect(logged).not.toContain(SECRET);
  });

  it("the iQIES submit worker: a failing batch-list read for org A does not stop org B", async () => {
    submissionStore.queuedSubmissionsForOrg.mockImplementation(
      async (_tx: unknown, org: string) => {
        if (org === ORG_A) throw pgError("42P01");
        return [];
      },
    );

    await expect(runIqiesSubmitCron(baseDeps())).rejects.toBeInstanceOf(AggregateError);

    expect(submissionStore.queuedSubmissionsForOrg.mock.calls.map((c) => c[1])).toEqual([
      ORG_A,
      ORG_B,
    ]);
    expect(loggedErrors(errors)).toContain(ORG_A);
  });

  it("the iQIES reconcile worker: a failing batch-list read for org A does not stop org B", async () => {
    submissionStore.inFlightSubmissionsForOrg.mockImplementation(
      async (_tx: unknown, org: string) => {
        if (org === ORG_A) throw pgError("42P01");
        return [];
      },
    );

    await expect(runIqiesReconcileCron(baseDeps())).rejects.toBeInstanceOf(AggregateError);

    expect(submissionStore.inFlightSubmissionsForOrg.mock.calls.map((c) => c[1])).toEqual([
      ORG_A,
      ORG_B,
    ]);
    expect(loggedErrors(errors)).toContain(ORG_A);
  });
});

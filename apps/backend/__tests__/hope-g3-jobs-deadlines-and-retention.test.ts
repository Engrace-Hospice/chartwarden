import type { DbClient } from "@chartwarden/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// M10 group g3 (round 3), the background jobs, with the stores and the database faked (no live infrastructure):
//  - `withinDeadline` must always settle: a timeout error or an `onAbandoned` hook that throws cannot leave it pending;
//  - the alert emit's abandoned-emit cap is per org, is checked before EVERY emit, and a late settle is logged with ids;
//  - the retention scan keeps an already-flagged patient's `flagged_at`, and a lost INSERT race is skipped, not fatal.
const retentionStore = vi.hoisted(() => ({
  hopeRetentionFactsForOrg: vi.fn(),
  insertRetentionReview: vi.fn(),
  retentionReviewsForOrg: vi.fn(),
  updateRetentionReview: vi.fn(),
}));
vi.mock("../src/modules/10-hope/jobs/retention-store", () => retentionStore);

import type {
  M10WorkerDeps,
  runHopeRetentionCron as RunHopeRetentionCron,
} from "../src/modules/10-hope/jobs/cron-workers";
import type { withinDeadline as WithinDeadline } from "../src/modules/10-hope/jobs/deadline";
import {
  type deliverAlerts as DeliverAlerts,
  M10_ALERT_EMIT_TIMEOUT_MS,
  M10_ALERT_MAX_ABANDONED_EMITS,
  M10_ALERT_MAX_ABANDONED_EMITS_PROCESS,
  type PlannedM10AlertEmission,
} from "../src/modules/10-hope/jobs/watchdog-alerts";

// `watchdog-alerts` counts timed-out emits that are still running in module-level state with no reset, per org and per
// process. Each test loads a FRESH copy of the job modules (vi.resetModules in beforeEach, one graph for all of them), so a
// test that leaves emits hanging, or fails before it frees them, cannot starve the next test. The constants above are plain
// values and identical in every copy.
let deliverAlerts: typeof DeliverAlerts;
let runHopeRetentionCron: typeof RunHopeRetentionCron;
let withinDeadline: typeof WithinDeadline;

const NOW = new Date("2030-06-01T00:00:00.000Z");
const PATIENT = "99999999-9999-4999-8999-999999999999";
const PATIENT_2 = "99999999-9999-4999-8999-999999999998";
const REVIEW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET = "secret-value-from-a-driver-message";
const ANSWER = { alertId: "alert-id-0001", resolvedRecipientCount: 1 };

/** A distinct org id per call, so one test's orgs keep their per-org abandoned-emit counts apart. */
let orgSeq = 0;
const freshOrg = (): string => `00000000-0000-4000-8000-${String(++orgSeq).padStart(12, "0")}`;

const alertsOf = (count: number): PlannedM10AlertEmission[] =>
  Array.from({ length: count }, (_, i) => ({
    eventType: "m10.hope.sfv_overdue" as const,
    severity: "critical" as const,
    correlationId: `c${i + 1}`,
    payload: {},
  }));

const loggedOf = (spy: { mock: { calls: readonly unknown[][] } }): string =>
  spy.mock.calls.map((call) => String(call[0])).join("\n");

function pgError(code: string): Error {
  const driver = Object.assign(new Error(`failed for patient ${PATIENT} ${SECRET}`), {
    code,
    name: "error",
  });
  return new Error("Failed query", { cause: driver });
}

let errors: { mock: { calls: readonly unknown[][] } };
let warnings: { mock: { calls: readonly unknown[][] } };
beforeEach(async () => {
  vi.resetModules();
  ({ deliverAlerts } = await import("../src/modules/10-hope/jobs/watchdog-alerts"));
  ({ withinDeadline } = await import("../src/modules/10-hope/jobs/deadline"));
  ({ runHopeRetentionCron } = await import("../src/modules/10-hope/jobs/cron-workers"));
  for (const fn of Object.values(retentionStore)) fn.mockReset();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withinDeadline always settles", () => {
  it("an onAbandoned hook that throws does not leave the promise pending or raise an uncaught exception, and is logged by class", async () => {
    vi.useFakeTimers();
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      const timeout = new Error("deadline");
      const run = withinDeadline(
        () => new Promise<never>(() => {}),
        50,
        () => timeout,
        () => {
          throw new TypeError(`hook failed for ${SECRET}`);
        },
      );
      const settled = run.then(
        () => "resolved",
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(50);

      expect(await settled).toBe(timeout);
      expect(uncaught).not.toHaveBeenCalled();
      const logged = loggedOf(errors);
      expect(logged).toContain("TypeError");
      expect(logged).not.toContain(SECRET);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("uncaughtException", uncaught);
    }
  });

  it("a timeoutError factory that throws falls back to a plain Error, and the hook still runs", async () => {
    vi.useFakeTimers();
    const onAbandoned = vi.fn();
    const run = withinDeadline(
      () => new Promise<never>(() => {}),
      50,
      () => {
        throw new Error("factory failed");
      },
      onAbandoned,
    );
    const settled = run.then(
      () => "resolved",
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(50);

    expect(await settled).toMatchObject({ message: "the call did not answer within 50 ms" });
    expect(onAbandoned).toHaveBeenCalledTimes(1);
  });
});

describe("the abandoned-emit cap: per org, checked before every emit, late outcomes logged", () => {
  /** An emitter whose emits stay pending until `settle` / `fail` is called; every call is recorded. */
  function hangingEmitter() {
    const settlers: Array<{ ok: () => void; fail: (error: Error) => void }> = [];
    const emit = vi.fn(
      (_org: string, _alert: { correlationId: string }) =>
        new Promise<typeof ANSWER>((resolve, reject) => {
          settlers.push({ ok: () => resolve(ANSWER), fail: reject });
        }),
    );
    return {
      emit,
      settleAll: async () => {
        for (const s of settlers.splice(0)) s.ok();
        await vi.advanceTimersByTimeAsync(0);
      },
      failAll: async (error: Error) => {
        for (const s of settlers.splice(0)) s.fail(error);
        await vi.advanceTimersByTimeAsync(0);
      },
    };
  }

  /** One org, one alert, run to its deadline (that emit is then abandoned, still running). */
  async function timeOutOneEmit(
    emitter: { emit: ReturnType<typeof hangingEmitter>["emit"] },
    organizationId: string,
  ) {
    const run = deliverAlerts(emitter, organizationId, "sfv-watchdog", alertsOf(1));
    await vi.advanceTimersByTimeAsync(M10_ALERT_EMIT_TIMEOUT_MS);
    return run;
  }

  it("alerts that hang one by one while the LAST alert answers stop the org at the cap instead of costing one deadline per alert", async () => {
    vi.useFakeTimers();
    const org = freshOrg();
    // c1..c3 hang, c40 (the probe) answers, then c4..c6 hang: six abandoned emits, so the org stops before c7.
    const hanging = hangingEmitter();
    const emit = vi.fn((organizationId: string, alert: { correlationId: string }) =>
      alert.correlationId === "c40" ? Promise.resolve(ANSWER) : hanging.emit(organizationId, alert),
    );

    const run = deliverAlerts({ emit }, org, "sfv-watchdog", alertsOf(40));
    await vi.advanceTimersByTimeAsync(M10_ALERT_EMIT_TIMEOUT_MS * 40);
    const result = await run;
    await hanging.settleAll(); // leave no abandoned emit behind for the tests after this one

    expect(emit).toHaveBeenCalledTimes(M10_ALERT_MAX_ABANDONED_EMITS + 1); // six hangs and the probe
    expect(result).toMatchObject({
      failed: M10_ALERT_MAX_ABANDONED_EMITS,
      skipped: 33, // c7..c39: the last alert was already emitted as the probe
    });
    expect(result.firstError).toMatchObject({ name: "AlertEmitTimeoutError" });
    const logged = loggedOf(errors);
    expect(logged).toContain(org);
    expect(logged).toContain("33");
    expect(logged).toContain("still running");
  });

  it("one org's hung emits do not stop another org from delivering", async () => {
    vi.useFakeTimers();
    const hungOrg = freshOrg();
    const healthyOrg = freshOrg();
    const hanging = hangingEmitter();
    for (let i = 0; i < M10_ALERT_MAX_ABANDONED_EMITS; i += 1) {
      await timeOutOneEmit(hanging, hungOrg);
    }

    const blocked = await deliverAlerts(hanging, hungOrg, "sfv-watchdog", alertsOf(2));
    const healthyEmit = vi.fn(async () => ANSWER);
    const healthy = await deliverAlerts(
      { emit: healthyEmit },
      healthyOrg,
      "sfv-watchdog",
      alertsOf(2),
    );

    expect(blocked).toMatchObject({ failed: 0, skipped: 2 });
    expect(blocked.firstError).toMatchObject({ name: "AlertEmitBackpressureError" });
    expect(healthy).toEqual({ failed: 0, skipped: 0 });
    expect(healthyEmit).toHaveBeenCalledTimes(2);
    await hanging.settleAll();
  });

  it(`${M10_ALERT_MAX_ABANDONED_EMITS_PROCESS} abandoned emits across orgs stop every org (the process-wide ceiling)`, async () => {
    vi.useFakeTimers();
    const hanging = hangingEmitter();
    const orgsAtTheirCap = Math.floor(
      M10_ALERT_MAX_ABANDONED_EMITS_PROCESS / M10_ALERT_MAX_ABANDONED_EMITS,
    );
    for (let o = 0; o < orgsAtTheirCap; o += 1) {
      const org = freshOrg();
      for (let i = 0; i < M10_ALERT_MAX_ABANDONED_EMITS; i += 1) await timeOutOneEmit(hanging, org);
    }
    const bystander = freshOrg();

    const blocked = await deliverAlerts(hanging, bystander, "sfv-watchdog", alertsOf(2));

    expect(blocked).toMatchObject({ failed: 0, skipped: 2 });
    expect(String((blocked.firstError as Error).message)).toContain(
      `${M10_ALERT_MAX_ABANDONED_EMITS_PROCESS} or more`,
    );
    await hanging.settleAll();
    const emit = vi.fn(async () => ANSWER);
    await expect(deliverAlerts({ emit }, bystander, "sfv-watchdog", alertsOf(1))).resolves.toEqual({
      failed: 0,
      skipped: 0,
    });
  });

  // An ordered pair: part 1 leaves the PROCESS-wide ceiling reached (its hung emits never settle; a distinct org id per
  // test cannot hide that, the process count is shared), part 2 must not inherit it. Without a fresh module copy per test,
  // part 2 is refused as backpressure.
  it("(isolation, part 1) leaves the process-wide abandoned-emit ceiling reached on purpose", async () => {
    vi.useFakeTimers();
    const hanging = hangingEmitter();
    const orgsAtTheirCap = Math.floor(
      M10_ALERT_MAX_ABANDONED_EMITS_PROCESS / M10_ALERT_MAX_ABANDONED_EMITS,
    );
    for (let o = 0; o < orgsAtTheirCap; o += 1) {
      const org = freshOrg();
      for (let i = 0; i < M10_ALERT_MAX_ABANDONED_EMITS; i += 1) await timeOutOneEmit(hanging, org);
    }

    const blocked = await deliverAlerts(hanging, freshOrg(), "sfv-watchdog", alertsOf(1));

    expect(blocked).toMatchObject({ failed: 0, skipped: 1 });
  });

  it("(isolation, part 2) the previous test's abandoned emits do not count here", async () => {
    const emit = vi.fn(async () => ANSWER);

    await expect(deliverAlerts({ emit }, freshOrg(), "sfv-watchdog", alertsOf(1))).resolves.toEqual(
      { failed: 0, skipped: 0 },
    );
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("an abandoned emit that answers late is logged with its ids and frees its slot", async () => {
    vi.useFakeTimers();
    const org = freshOrg();
    const hanging = hangingEmitter();
    for (let i = 0; i < M10_ALERT_MAX_ABANDONED_EMITS; i += 1) await timeOutOneEmit(hanging, org);

    await hanging.settleAll();

    const warned = loggedOf(warnings);
    expect(warned).toContain(org);
    expect(warned).toContain("correlation c1");
    expect(warned).toContain(ANSWER.alertId);
    const emit = vi.fn(async () => ANSWER);
    await expect(deliverAlerts({ emit }, org, "sfv-watchdog", alertsOf(1))).resolves.toEqual({
      failed: 0,
      skipped: 0,
    });
  });

  it("an abandoned emit that fails late is logged with its SQLSTATE and ids, never the driver message", async () => {
    vi.useFakeTimers();
    const org = freshOrg();
    const hanging = hangingEmitter();
    await timeOutOneEmit(hanging, org);
    vi.mocked(console.error).mockClear(); // only what the late failure logs

    await hanging.failAll(pgError("40P01"));

    const logged = loggedOf(errors);
    expect(logged).toContain("SQLSTATE 40P01");
    expect(logged).toContain(org);
    expect(logged).toContain("correlation c1");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PATIENT);
  });
});

describe("the retention scan's flag instant and insert race", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const factsFor = (patientId: string) => ({
    patientId,
    providerEntityId: null,
    locationId: null,
    lastEffectiveAt: new Date("2000-01-01T00:00:00.000Z"), // long past the 7-year horizon
    lastTransmittedAt: null,
    openIqiesError: false,
    pendingCorrection: false,
    legalHold: false,
  });
  const fakeDb = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: async () => undefined }),
  } as unknown as DbClient;
  const baseDeps = (over: Partial<M10WorkerDeps> = {}): M10WorkerDeps => ({
    connection: {} as never,
    db: fakeDb,
    outbox: { publish: vi.fn(async () => undefined) },
    activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
    retentionHolds: {
      activeLegalHoldScopeForOrg: async () => ({ orgWide: false, patientIds: new Set<string>() }),
    },
    now: () => NOW,
    ...over,
  });
  const writeOf = (callIndex = 0): Record<string, unknown> =>
    retentionStore.updateRetentionReview.mock.calls[callIndex]?.[3] as Record<string, unknown>;

  it("an already-eligible patient's update leaves flaggedAt OUT, so the original flag instant is kept", async () => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([factsFor(PATIENT)]);
    retentionStore.retentionReviewsForOrg.mockResolvedValue([
      { id: REVIEW_ID, patientId: PATIENT, status: "eligible" },
    ]);
    retentionStore.updateRetentionReview.mockResolvedValue(true);
    const publish = vi.fn(async () => undefined);

    await runHopeRetentionCron(baseDeps({ outbox: { publish } }));

    expect(writeOf()).toMatchObject({ status: "eligible" });
    expect("flaggedAt" in writeOf()).toBe(false);
    expect(publish).not.toHaveBeenCalled(); // not newly eligible: nothing announced again
  });

  it("a patient that becomes eligible is stamped with the scan's instant", async () => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([factsFor(PATIENT)]);
    retentionStore.retentionReviewsForOrg.mockResolvedValue([
      { id: REVIEW_ID, patientId: PATIENT, status: "blocked" },
    ]);
    retentionStore.updateRetentionReview.mockResolvedValue(true);

    await runHopeRetentionCron(baseDeps());

    expect(writeOf()).toMatchObject({ status: "eligible", flaggedAt: NOW });
  });

  it("a patient that leaves eligible has its flag instant cleared (an explicit null)", async () => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([factsFor(PATIENT)]);
    retentionStore.retentionReviewsForOrg.mockResolvedValue([
      { id: REVIEW_ID, patientId: PATIENT, status: "eligible" },
    ]);
    retentionStore.updateRetentionReview.mockResolvedValue(true);

    await runHopeRetentionCron(
      baseDeps({
        retentionHolds: {
          activeLegalHoldScopeForOrg: async () => ({
            orgWide: true,
            patientIds: new Set<string>(),
          }),
        },
      }),
    );

    expect(writeOf()).toMatchObject({ status: "blocked", flaggedAt: null });
  });

  it("a new row for a patient another scan already inserted (or whose records were destroyed) is skipped, not fatal: the next patient is still written and announced", async () => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([
      factsFor(PATIENT),
      factsFor(PATIENT_2),
    ]);
    retentionStore.retentionReviewsForOrg.mockResolvedValue([]);
    retentionStore.insertRetentionReview
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(REVIEW_ID);
    const publish = vi.fn(async () => undefined);

    await expect(runHopeRetentionCron(baseDeps({ outbox: { publish } }))).resolves.toBeUndefined();

    expect(retentionStore.insertRetentionReview).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1); // only the patient whose row was inserted is announced
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ aggregateId: REVIEW_ID }),
    );
    const warned = loggedOf(warnings);
    expect(warned).toContain(ORG);
    expect(warned).not.toContain(PATIENT);
    expect(loggedOf(errors)).toBe("");
  });
});

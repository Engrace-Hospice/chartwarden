import type { DbClient } from "@chartwarden/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The ticks' orchestration (every org attempted, one throw at the end, ids-only logs, replay planning, the per-org
// breaker, the zero-recipient signal) with the store and the database faked: no live infrastructure.
const store = vi.hoisted(() => ({
  openHopeSchedulesForOrg: vi.fn(),
  openOrOverdueSfvsForOrg: vi.fn(),
  recentlyExpiredSchedulesForOrg: vi.fn(),
  sfvsToReplayAlertsForOrg: vi.fn(),
  updateHopeScheduleStatus: vi.fn(),
  updateSfvStatus: vi.fn(),
}));
vi.mock("../src/modules/10-hope/jobs/cron-store", () => store);

import { M10_JOB_PARAMS } from "../src/modules/10-hope/jobs/index";
import { deliverAlerts, describeError } from "../src/modules/10-hope/jobs/watchdog-alerts";
import {
  type WatchdogTickDeps,
  runSfvWatchdogTick,
  runWindowWatchdogTick,
} from "../src/modules/10-hope/jobs/watchdog-ticks";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const SFV_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SFV_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const SFV_3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const PATIENT = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-06-10T12:00:00.000Z");

const overdueSfv = (sfvId: string) => ({
  sfvId,
  patientId: PATIENT,
  admissionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  triggeringAssessmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  status: "overdue" as const,
  dueAt: "2026-06-09T00:00:00.000Z",
  timeZone: "America/Los_Angeles",
});

/** A database whose transaction just runs the callback: the faked store never touches the tx. */
const fakeDb = {
  transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: async () => undefined }),
} as unknown as DbClient;

function depsOf(
  over: Partial<WatchdogTickDeps> & Pick<WatchdogTickDeps, "organizationIds">,
): WatchdogTickDeps {
  return {
    db: fakeDb,
    outbox: { publish: vi.fn(async () => undefined) },
    now: NOW,
    systemUserId: "",
    ...over,
  };
}

/** A node-postgres-shaped failure: named "error", with the SQLSTATE and a message that carries a value. */
function pgError(code: string): Error {
  const driver = Object.assign(new Error(`update failed for patient ${PATIENT} secret value`), {
    code,
    name: "error",
  });
  return new Error("Failed query", { cause: driver });
}

/** Everything a spied `console.error` was called with, as one string. */
const loggedErrors = (spy: { mock: { calls: readonly unknown[][] } }): string =>
  spy.mock.calls.map((call) => String(call[0])).join("\n");

describe("the SFV watchdog tick's orchestration", () => {
  let errors: { mock: { calls: readonly unknown[][] } };
  beforeEach(() => {
    for (const fn of Object.values(store)) fn.mockReset();
    store.openOrOverdueSfvsForOrg.mockResolvedValue([]);
    store.sfvsToReplayAlertsForOrg.mockResolvedValue([]);
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("attempts every org when one fails, throws once at the end with the first error as the cause, and logs ids and the SQLSTATE only", async () => {
    const failure = pgError("40P01");
    store.openOrOverdueSfvsForOrg.mockImplementation(async (_tx: unknown, org: string) => {
      if (org === ORG_A) throw failure;
      return [];
    });
    store.sfvsToReplayAlertsForOrg.mockResolvedValue([overdueSfv(SFV_1)]);
    const emit = vi.fn(async (_org: string, _alert: unknown) => ({
      alertId: "a",
      resolvedRecipientCount: 1,
    }));

    const run = runSfvWatchdogTick(depsOf({ organizationIds: [ORG_A, ORG_B], alerts: { emit } }));

    await expect(run).rejects.toMatchObject({
      message: expect.stringMatching(/failed for 1 of 2 org/),
      cause: failure,
    });
    // ORG_B came after the failing org and was still processed and alerted.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe(ORG_B);
    const logged = loggedErrors(errors);
    expect(logged).toContain(ORG_A);
    expect(logged).toContain("SQLSTATE 40P01");
    expect(logged).not.toContain("secret value");
    expect(logged).not.toContain(PATIENT);
  });

  it("re-plans its alerts from the committed state, not from this tick's transitions", async () => {
    store.openOrOverdueSfvsForOrg.mockResolvedValue([]); // nothing transitions this tick
    store.sfvsToReplayAlertsForOrg.mockResolvedValue([overdueSfv(SFV_1), overdueSfv(SFV_2)]);
    const emit = vi.fn(async (_org: string, _alert: unknown) => ({
      alertId: "a",
      resolvedRecipientCount: 1,
    }));

    await runSfvWatchdogTick(depsOf({ organizationIds: [ORG_A], alerts: { emit } }));

    expect(
      emit.mock.calls
        .map((c) => (c as unknown[])[1])
        .map((a) => (a as { correlationId: string }).correlationId),
    ).toEqual([
      `${ORG_A}:m10.hope.sfv_overdue:${SFV_1}:overdue`,
      `${ORG_A}:m10.hope.sfv_overdue:${SFV_2}:overdue`,
    ]);
  });

  it("keeps emitting past a failed alert (three in a row stop an org for the tick) and still delivers the next org", async () => {
    store.sfvsToReplayAlertsForOrg.mockImplementation(async (_tx: unknown, org: string) =>
      org === ORG_A
        ? [overdueSfv(SFV_1), overdueSfv(SFV_2), overdueSfv(SFV_3)]
        : [overdueSfv(SFV_1), overdueSfv(SFV_2)],
    );
    const emit = vi.fn(async (org: string, _alert: unknown) => {
      if (org === ORG_A) throw pgError("55P03");
      return { alertId: "a", resolvedRecipientCount: 1 };
    });

    const run = runSfvWatchdogTick(depsOf({ organizationIds: [ORG_A, ORG_B], alerts: { emit } }));

    await expect(run).rejects.toThrow(/failed for 1 of 2 org/);
    // Every one of ORG_A's three alerts was attempted (the third consecutive failure leaves nothing to skip).
    expect(emit.mock.calls.filter((c) => c[0] === ORG_A)).toHaveLength(3);
    expect(emit.mock.calls.filter((c) => c[0] === ORG_B)).toHaveLength(2);
    const logged = loggedErrors(errors);
    expect(logged).not.toContain("remaining alert(s) skipped");
    expect(logged).toContain("SQLSTATE 55P03");
  });

  it("logs a zero-recipient emit at error level (ids only) and does not fail the tick", async () => {
    store.sfvsToReplayAlertsForOrg.mockResolvedValue([overdueSfv(SFV_1)]);
    const emit = vi.fn(async (_org: string, _alert: unknown) => ({
      alertId: "alert-id-0001",
      resolvedRecipientCount: 0,
    }));

    await expect(
      runSfvWatchdogTick(depsOf({ organizationIds: [ORG_A], alerts: { emit } })),
    ).resolves.toBeUndefined();

    const logged = loggedErrors(errors);
    // What the count is: today's rules for THIS call, so the line says "resolved", never that the alert "reached 0".
    expect(logged).toContain("resolved 0 recipients under the organization's current alert rules");
    expect(logged).not.toContain("reached 0 recipients");
    expect(logged).toContain("alert-id-0001");
    expect(logged).toContain(`${ORG_A}:m10.hope.sfv_overdue:${SFV_1}:overdue`);
    expect(logged).not.toContain(PATIENT);
  });

  it("plans and emits nothing when no alert emitter is bound", async () => {
    store.sfvsToReplayAlertsForOrg.mockResolvedValue([overdueSfv(SFV_1)]);

    await runSfvWatchdogTick(depsOf({ organizationIds: [ORG_A] }));

    expect(store.sfvsToReplayAlertsForOrg).not.toHaveBeenCalled();
  });
});

describe("the window watchdog tick's orchestration", () => {
  beforeEach(() => {
    for (const fn of Object.values(store)) fn.mockReset();
    store.openHopeSchedulesForOrg.mockResolvedValue([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("re-plans its expired alerts from the committed state with the deterministic id", async () => {
    store.recentlyExpiredSchedulesForOrg.mockResolvedValue([
      {
        scheduleId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        patientId: PATIENT,
        admissionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        rfaKind: "01_admission",
        status: "expired",
        windowOpensAt: "2026-05-01T00:00:00.000Z",
        windowClosesAt: "2026-05-06T00:00:00.000Z",
        lateDeadlineAt: "2026-05-13T00:00:00.000Z",
      },
    ]);
    const emit = vi.fn(async (_org: string, _alert: unknown) => ({
      alertId: "a",
      resolvedRecipientCount: 1,
    }));

    await runWindowWatchdogTick(depsOf({ organizationIds: [ORG_A], alerts: { emit } }));

    expect((emit.mock.calls[0] as unknown[])[1]).toMatchObject({
      correlationId: `${ORG_A}:m10.hope.timepoint_expired:dddddddd-dddd-4ddd-8ddd-dddddddddddd:window_expired`,
    });
  });
});

describe("describeError", () => {
  it("names the class and the SQLSTATE found anywhere on the cause chain, never the message", () => {
    expect(describeError(pgError("40001"))).toBe("Error SQLSTATE 40001");
  });

  it("ignores a code that is not a SQLSTATE (a Node error code, a custom code)", () => {
    expect(describeError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("Error");
    expect(describeError(Object.assign(new Error("x"), { code: "M10_X" }))).toBe("Error");
  });

  it("labels a non-error", () => {
    expect(describeError("boom")).toBe("non-error");
  });
});

describe("deliverAlerts", () => {
  it("counts every failed emit, keeps the first error as the cause, and skips nothing when the last alert trips the breaker", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("down");
    const emit = vi.fn(async () => {
      throw failure;
    });
    const alerts = [1, 2, 3].map((n) => ({
      eventType: "m10.hope.sfv_overdue" as const,
      severity: "critical" as const,
      correlationId: `c${n}`,
      payload: {},
    }));

    const result = await deliverAlerts({ emit }, ORG_A, "sfv-watchdog", alerts);

    expect(result).toEqual({ failed: 3, skipped: 0, firstError: failure });
    expect(emit).toHaveBeenCalledTimes(3);
  });
});

describe("the watchdog jobs' retry policy", () => {
  it.each(["hope-window-watchdog", "sfv-watchdog"] as const)(
    "%s runs with ONE attempt: a failed tick fails the job once and the next firing is the retry (the replay recovers the rest)",
    (job) => {
      expect(M10_JOB_PARAMS[job].attempts).toBe(1);
    },
  );
});

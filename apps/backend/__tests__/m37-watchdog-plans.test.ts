// apps/backend/__tests__/m37-watchdog-plans.test.ts — GAP-105 (#174). The decisions behind M37's five
// remaining §4.8 crons, with no Redis or database: the IRC day catch-up (cap at day 5), the nag-cycle
// window, the restraint / bed-cleaning / GIP-staleness planners, the queue catalog, and M36's IPU alert
// consumer. The end-to-end write path is `m37-watchdog-crons.live.test.ts`.
import { describe, expect, it } from "vitest";
import {
  M36_IPU_ALERT_EVENT_TYPES,
  buildM36IpuAlertConsumer,
  planIpuAlert,
} from "../src/modules/36-messaging/outbox-consumers/ipu-alerts";
import {
  GIP_STALENESS_SWEEP_HOURS,
  M37_WATCHDOG_QUEUES,
  M37_WATCHDOG_SCHEDULES,
  addDaysToIsoDate,
  daysBetweenIsoDates,
  planBedCleaningOverdue,
  planGipStaleness,
  planIrcCatchUp,
  planRestraintReassessmentDue,
  reminderCycle,
} from "../src/modules/37-ipu/jobs/watchdog-plans";
import { M37_WATCHDOG_JOBS } from "../src/modules/37-ipu/jobs/watchdog-workers";

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

describe("GAP-105 — queue catalog", () => {
  it("names carry no ':' and every job has a schedule, params and a runner", () => {
    for (const job of M37_WATCHDOG_JOBS) {
      expect(job.queue).not.toContain(":");
      expect(job.schedule).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
      expect(job.params.attempts).toBeGreaterThan(0);
      expect(typeof job.run).toBe("function");
    }
    expect(M37_WATCHDOG_JOBS.map((j) => j.queue).sort()).toEqual(
      Object.values(M37_WATCHDOG_QUEUES).sort(),
    );
  });

  it("runs the census after the IRC tick and the restraint watchdog every 15 minutes", () => {
    expect(M37_WATCHDOG_SCHEDULES.ircCapWatchdog).toBe("10 * * * *");
    expect(M37_WATCHDOG_SCHEDULES.censusSnapshotBuilder).toBe("40 * * * *");
    expect(M37_WATCHDOG_SCHEDULES.restraintReassessmentWatchdog).toBe("*/15 * * * *");
  });
});

describe("GAP-105 — local date arithmetic", () => {
  it("adds and diffs calendar days across month and DST boundaries", () => {
    expect(addDaysToIsoDate("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDaysToIsoDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(daysBetweenIsoDates("2026-10-01", "2026-10-05")).toBe(4);
    expect(daysBetweenIsoDates("2026-10-05", "2026-10-01")).toBe(-4);
  });
});

describe("GAP-105 — planIrcCatchUp (§2.5)", () => {
  const fresh = {
    consecutiveDayCount: 1,
    state: "active",
    overrideExtensionDays: 0,
    startedLocalDate: "2026-10-01",
  } as const;

  it("is a no-op on the start date and on a re-run once the count matches the calendar", () => {
    expect(planIrcCatchUp(fresh, "2026-10-01")).toBeNull();
    expect(planIrcCatchUp({ ...fresh, consecutiveDayCount: 3 }, "2026-10-03")).toBeNull();
  });

  it("reaches day 4 and emits cap_approaching exactly once", () => {
    const plan = planIrcCatchUp(fresh, "2026-10-04");
    expect(plan).toMatchObject({ consecutiveDayCount: 4, state: "approaching_cap" });
    expect(plan?.events).toEqual([
      { event: "m37.irc_episode.cap_approaching", consecutiveDayCount: 4 },
    ]);
  });

  it("emits cap_breached at day 5", () => {
    const plan = planIrcCatchUp(
      { ...fresh, consecutiveDayCount: 4, state: "approaching_cap" },
      "2026-10-05",
    );
    expect(plan).toMatchObject({ consecutiveDayCount: 5, state: "breached" });
    expect(plan?.events).toEqual([
      { event: "m37.irc_episode.cap_breached", consecutiveDayCount: 5 },
    ]);
  });

  it("catches up a missed stretch, reporting each state entry once and never re-announcing breached", () => {
    const plan = planIrcCatchUp(fresh, "2026-10-08");
    expect(plan?.consecutiveDayCount).toBe(8);
    expect(plan?.events.map((e) => e.event)).toEqual([
      "m37.irc_episode.cap_approaching",
      "m37.irc_episode.cap_breached",
    ]);
    const again = planIrcCatchUp(
      { ...fresh, consecutiveDayCount: 8, state: "breached" },
      "2026-10-08",
    );
    expect(again).toBeNull();
  });

  it("honours a granted override extension (cap moves from day 5 to day 7)", () => {
    const plan = planIrcCatchUp({ ...fresh, overrideExtensionDays: 2 }, "2026-10-05");
    expect(plan).toMatchObject({ consecutiveDayCount: 5, state: "active" });
    expect(plan?.events).toEqual([]);
  });

  it("never ticks a closed episode", () => {
    expect(planIrcCatchUp({ ...fresh, state: "closed" }, "2026-10-09")).toBeNull();
  });
});

describe("GAP-105 — reminderCycle", () => {
  const due = NOW;
  it("is null before the deadline and fires once inside the first window of each cycle", () => {
    expect(reminderCycle(due, due - MIN, 15 * MIN, 20 * MIN)).toBeNull();
    expect(reminderCycle(due, due, 120 * MIN, 20 * MIN)).toBe(0);
    expect(reminderCycle(due, due + 10 * MIN, 120 * MIN, 20 * MIN)).toBe(0);
    expect(reminderCycle(due, due + 30 * MIN, 120 * MIN, 20 * MIN)).toBeNull();
    expect(reminderCycle(due, due + 125 * MIN, 120 * MIN, 20 * MIN)).toBe(1);
  });

  it("fires every tick for a repeat shorter than the window (one cycle index per period)", () => {
    expect(reminderCycle(due, due + 16 * MIN, 15 * MIN, 20 * MIN)).toBe(1);
  });
});

describe("GAP-105 — planRestraintReassessmentDue (§2.10)", () => {
  const r = (lastAssessedAtMs: number, intervalMinutes: number) => ({
    restraintEventId: "r1",
    ipuAdmissionId: "a1",
    intervalMinutes,
    lastAssessedAtMs,
  });

  it("does nothing while the interval has not elapsed", () => {
    expect(planRestraintReassessmentDue([r(NOW - 10 * MIN, 15)], NOW)).toEqual([]);
  });

  it("flags a 15-minute behavioral restraint past due, with its due instant and cycle", () => {
    const plans = planRestraintReassessmentDue([r(NOW - 20 * MIN, 15)], NOW);
    expect(plans).toEqual([
      { restraintEventId: "r1", ipuAdmissionId: "a1", dueAtMs: NOW - 5 * MIN, cycle: 0 },
    ]);
  });

  it("does not re-raise a 2-hour medical restraint on every tick of the same cycle", () => {
    expect(planRestraintReassessmentDue([r(NOW - 150 * MIN, 120)], NOW)).toEqual([]);
    expect(planRestraintReassessmentDue([r(NOW - 125 * MIN, 120)], NOW)).toHaveLength(1);
  });
});

describe("GAP-105 — planBedCleaningOverdue (§2.12)", () => {
  const bed = (
    status: "discharged_dirty" | "cleaning" | "ready",
    dirtyMinutesAgo: number,
    sla = 120,
  ) => ({
    bedId: "b1",
    unitId: "u1",
    status,
    dischargedDirtyAtMs: NOW - dirtyMinutesAgo * MIN,
    configuredSlaMinutes: sla,
  });

  it("flags a bed past the 2-hour floor and ignores one inside it or already ready", () => {
    expect(planBedCleaningOverdue([bed("discharged_dirty", 125)], NOW)).toHaveLength(1);
    expect(planBedCleaningOverdue([bed("cleaning", 90)], NOW)).toEqual([]);
    expect(planBedCleaningOverdue([bed("ready", 500)], NOW)).toEqual([]);
  });

  it("applies a tighter tenant SLA, and falls back to the floor for a corrupt looser value", () => {
    expect(planBedCleaningOverdue([bed("cleaning", 70, 60)], NOW)[0]?.slaMinutes).toBe(60);
    expect(planBedCleaningOverdue([bed("cleaning", 125, 600)], NOW)[0]?.slaMinutes).toBe(120);
  });
});

describe("GAP-105 — planGipStaleness (§2.4)", () => {
  it("flags only admissions stale beyond 72 hours", () => {
    const plans = planGipStaleness(
      [
        { ipuAdmissionId: "fresh", lastAssessedAtMs: NOW - 71 * HOUR, hasReassessment: true },
        { ipuAdmissionId: "stale", lastAssessedAtMs: NOW - 80 * HOUR, hasReassessment: false },
      ],
      NOW,
    );
    expect(GIP_STALENESS_SWEEP_HOURS).toBe(72);
    expect(plans).toEqual([
      { ipuAdmissionId: "stale", lastAssessedAtMs: NOW - 80 * HOUR, staleHours: 80 },
    ]);
  });
});

describe("GAP-105 — M36 IPU alert consumer", () => {
  const ev = (eventType: string, payload: Record<string, unknown>) =>
    ({ id: "e1", organizationId: "org-1", eventType, payload }) as never;

  it("covers the GAP-105 events plus the batch 11 ones, each with a cron that publishes it", () => {
    expect([...M36_IPU_ALERT_EVENT_TYPES].sort()).toEqual([
      "m37.bed.cleaning_overdue",
      "m37.bed.reservation_expired",
      "m37.equipment.inspection_due",
      "m37.equipment.inspection_overdue",
      "m37.gip_criteria.reassessment_due",
      "m37.ipu_admission.transfer_unconfirmed",
      "m37.irc_episode.cap_approaching",
      "m37.irc_episode.cap_breached",
      "m37.nursing_note.shift_overdue",
      "m37.restraint.reassessment_due",
      "m37.shift.coverage_gap_projected",
      "m37.shift.rn_uncovered",
    ]);
  });

  it("raises cap_breached as critical with a per-day-count correlation key", () => {
    const plan = planIpuAlert(
      ev("m37.irc_episode.cap_breached", { ipuAdmissionId: "a1", consecutiveDayCount: 5 }),
    );
    expect(plan.severity).toBe("critical");
    expect(plan.correlationKey).toBe("a1:5");
  });

  it("keys a restraint alert by its nag cycle so a new cycle re-raises and a retry does not", () => {
    const k = (cycle: number) =>
      planIpuAlert(
        ev("m37.restraint.reassessment_due", { restraintEventId: "r1", reminderCycle: cycle }),
      ).correlationKey;
    expect(k(0)).toBe(k(0));
    expect(k(0)).not.toBe(k(1));
  });

  it("throws on a malformed payload so the relay dead-letters it", () => {
    expect(() => planIpuAlert(ev("m37.bed.cleaning_overdue", {}))).toThrow(/no bedId/);
    expect(() => planIpuAlert(ev("m37.irc_episode.cap_breached", { ipuAdmissionId: "a" }))).toThrow(
      /numeric/,
    );
  });

  it("emits under the EVENT'S organization (the envelope), not the payload's", async () => {
    const emitted: { org: string; input: { correlationId: string } }[] = [];
    const consumer = buildM36IpuAlertConsumer({
      emit: async (org: string, input: { correlationId: string }) => {
        emitted.push({ org, input });
      },
    } as never);
    await consumer.handle(
      ev("m37.bed.cleaning_overdue", {
        bedId: "b1",
        organizationId: "other-org",
        reminderCycle: 0,
      }),
    );
    expect(emitted[0]?.org).toBe("org-1");
    expect(emitted[0]?.input.correlationId).toContain("outbox:m37.bed.cleaning_overdue:b1");
  });
});

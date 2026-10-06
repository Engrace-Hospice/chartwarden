/**
 * GAP-044 — the pure planners behind the five M15 crons (§4.6). The Drizzle/outbox wiring is proven by
 * `gap-044-m15-crons.live.test.ts`; this file pins the decisions.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type M15WorkerDeps,
  fanOutOrgJobs,
} from "../src/modules/15-discipline-care-plans/jobs/cron-workers";
import {
  M15_JOB_SCHEDULES,
  M15_QUEUES,
  expiryCascades,
  localHourIn,
  planGateExpiryNotices,
  planGateWatcher,
  planInitialOverdue,
  planMswInitialAlerts,
  planSupervisoryOverdue,
} from "../src/modules/15-discipline-care-plans/jobs/index";

const DAY = 86_400_000;
const NOW = "2026-10-05T03:00:00.000Z";
const at = (offsetDays: number): string =>
  new Date(Date.parse(NOW) + offsetDays * DAY).toISOString();

describe("M15 cron catalog (§4.6)", () => {
  it("names the five queues exactly as the spec does", () => {
    expect(Object.values(M15_QUEUES).sort()).toEqual([
      "m15.chaplain.initial-overdue-check",
      "m15.msw.initial-overdue-check",
      "m15.supervisory.overdue-check",
      "m15.volunteer.gate-watcher",
      "m15.volunteer.hour-aggregator",
    ]);
    expect(M15_JOB_SCHEDULES.supervisoryOverdue).toBe("0 */6 * * *");
  });
});

describe("planSupervisoryOverdue", () => {
  const plan = (nextDue: string | null) => ({
    planId: "p1",
    nextSupervisoryDueAt: nextDue,
    cadenceDaysOverride: null,
  });

  it("emits nothing before the due instant, including the day-12 warning window", () => {
    expect(planSupervisoryOverdue([plan(at(1))], NOW)).toEqual([]);
    expect(planSupervisoryOverdue([plan(at(3))], NOW)).toEqual([]);
  });

  it("emits a warn with hoursOverdue once the 14-day clock is breached", () => {
    const out = planSupervisoryOverdue([plan(at(-1))], NOW);
    expect(out).toEqual([{ planId: "p1", hoursOverdue: 24, severity: "warn" }]);
  });

  it("escalates to critical once the CHHA encounter-sign gate engages (2 days past due)", () => {
    const out = planSupervisoryOverdue([plan(at(-3))], NOW);
    expect(out[0]).toMatchObject({ severity: "critical", hoursOverdue: 72 });
  });

  it("skips a plan whose clock is not armed", () => {
    expect(planSupervisoryOverdue([plan(null)], NOW)).toEqual([]);
  });
});

describe("planInitialOverdue", () => {
  const base = {
    planId: "p1",
    admissionId: "a1",
    initialAssessmentSignedAt: null,
    spiritualCareDeclinedAt: null,
  };

  it("reports an MSW plan 6 days past its anchor as 1 day overdue", () => {
    const out = planInitialOverdue([{ ...base, kind: "msw_plan", clockStartedAt: at(-6) }], NOW);
    expect(out).toEqual([{ planId: "p1", admissionId: "a1", daysOverdue: 1 }]);
  });

  it("does not report inside the 5-day window or without an armed clock", () => {
    expect(
      planInitialOverdue([{ ...base, kind: "msw_plan", clockStartedAt: at(-4) }], NOW),
    ).toEqual([]);
    expect(planInitialOverdue([{ ...base, kind: "msw_plan", clockStartedAt: null }], NOW)).toEqual(
      [],
    );
  });

  it("does not report a signed plan", () => {
    expect(
      planInitialOverdue(
        [{ ...base, kind: "msw_plan", clockStartedAt: at(-9), initialAssessmentSignedAt: at(-8) }],
        NOW,
      ),
    ).toEqual([]);
  });

  it("respects the chaplain declined-care path", () => {
    const declined = {
      ...base,
      kind: "spiritual_plan" as const,
      clockStartedAt: at(-9),
      spiritualCareDeclinedAt: at(-7),
    };
    expect(planInitialOverdue([declined], NOW)).toEqual([]);
    expect(planInitialOverdue([{ ...declined, spiritualCareDeclinedAt: null }], NOW)).toHaveLength(
      1,
    );
  });
});

describe("planGateWatcher", () => {
  const gate = (over: Record<string, unknown>) =>
    ({
      gateId: "g1",
      volunteerMembershipId: "v1",
      gateKind: "tb_screening",
      status: "satisfied",
      validFrom: at(-300),
      validUntil: at(60),
      revokedAt: null,
      lastNoticeDaysOut: null,
      ...over,
    }) as never;

  it("flips an elapsed gate to expire and never notifies for it", () => {
    const plan = planGateWatcher([gate({ validUntil: at(-1), status: "expiring_soon" })], NOW);
    expect(plan.toExpire).toHaveLength(1);
    expect(plan.notices).toEqual([]);
  });

  it("marks a satisfied gate expiring_soon inside the 30-day lead-in and fires the 30-day notice", () => {
    const plan = planGateWatcher([gate({ validUntil: at(30) })], NOW);
    expect(plan.toMarkExpiringSoon).toHaveLength(1);
    expect(plan.notices).toMatchObject([{ daysOut: 30, severity: "info" }]);
  });

  it("fires the 1-day ladder mark as critical and leaves off-mark days quiet", () => {
    expect(
      planGateWatcher([gate({ validUntil: at(1), status: "expiring_soon" })], NOW).notices,
    ).toMatchObject([{ daysOut: 1, severity: "critical" }]);
    expect(
      planGateWatcher(
        [gate({ validUntil: at(20), status: "expiring_soon", lastNoticeDaysOut: 30 })],
        NOW,
      ).notices,
    ).toEqual([]);
  });

  it("ignores non-expiring and far-future gates", () => {
    const plan = planGateWatcher([gate({ validUntil: null }), gate({ validUntil: at(200) })], NOW);
    expect(plan).toEqual({ toExpire: [], toMarkExpiringSoon: [], notices: [] });
  });

  it("cascades only for blocking gate kinds", () => {
    expect(expiryCascades(gate({ gateKind: "tb_screening" }))).toBe(true);
    expect(expiryCascades(gate({ gateKind: "vaccination_status" }))).toBe(false);
  });
});

describe("planMswInitialAlerts (severity ladder: day-3 warn / day-5 critical)", () => {
  const base = {
    planId: "p1",
    admissionId: "a1",
    kind: "msw_plan" as const,
    initialAssessmentSignedAt: null,
    spiritualCareDeclinedAt: null,
  };
  it("is silent before the day-3 warn mark", () => {
    expect(planMswInitialAlerts([{ ...base, clockStartedAt: at(-2) }], NOW)).toEqual([]);
  });
  it("warns from day 3 until the 5-day window lapses, with zero days overdue", () => {
    expect(planMswInitialAlerts([{ ...base, clockStartedAt: at(-3) }], NOW)).toEqual([
      { planId: "p1", admissionId: "a1", daysOverdue: 0, severity: "warn" },
    ]);
    expect(planMswInitialAlerts([{ ...base, clockStartedAt: at(-4.5) }], NOW)[0]?.severity).toBe(
      "warn",
    );
  });
  it("is critical once the 5-day window is breached", () => {
    expect(planMswInitialAlerts([{ ...base, clockStartedAt: at(-5) }], NOW)[0]).toMatchObject({
      severity: "critical",
      daysOverdue: 0,
    });
    expect(planMswInitialAlerts([{ ...base, clockStartedAt: at(-7) }], NOW)[0]).toMatchObject({
      severity: "critical",
      daysOverdue: 2,
    });
  });
  it("is silent once signed", () => {
    expect(
      planMswInitialAlerts(
        [{ ...base, clockStartedAt: at(-7), initialAssessmentSignedAt: at(-6) }],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("planGateExpiryNotices (tightest crossed mark, once per mark)", () => {
  const row = (daysOut: number, last: number | null) =>
    ({
      gateId: "g1",
      volunteerMembershipId: "v1",
      gateKind: "tb_screening",
      status: "expiring_soon",
      validFrom: at(-300),
      validUntil: at(daysOut),
      revokedAt: null,
      lastNoticeDaysOut: last,
    }) as never;

  it("fires the tightest crossed mark when a run was missed (10 days out -> the 14-day notice)", () => {
    expect(planGateExpiryNotices([row(10, null)], NOW)).toMatchObject([
      { daysOut: 14, severity: "warn" },
    ]);
    expect(planGateExpiryNotices([row(0, 7)], NOW)).toMatchObject([
      { daysOut: 1, severity: "critical" },
    ]);
  });
  it("sends nothing for a mark already notified, and nothing further out than 30 days", () => {
    expect(planGateExpiryNotices([row(10, 14)], NOW)).toEqual([]);
    expect(planGateExpiryNotices([row(9, 14)], NOW)).toEqual([]);
    expect(planGateExpiryNotices([row(31, null)], NOW)).toEqual([]);
  });
  it("advances to the next mark once crossed", () => {
    expect(planGateExpiryNotices([row(6, 14)], NOW)).toMatchObject([{ daysOut: 7 }]);
  });
  it("skips an already-elapsed or non-expiring gate", () => {
    expect(planGateExpiryNotices([row(-1, null)], NOW)).toEqual([]);
    expect(
      planGateExpiryNotices([{ ...(row(5, null) as object), validUntil: null } as never], NOW),
    ).toEqual([]);
  });
});

describe("localHourIn", () => {
  it("reads the wall-clock hour in the zone and falls back to UTC for a bad zone", () => {
    const at0300utc = new Date("2026-10-05T03:00:00.000Z");
    expect(localHourIn(at0300utc, "UTC")).toBe(3);
    expect(localHourIn(at0300utc, "Asia/Tokyo")).toBe(12);
    expect(localHourIn(at0300utc, "America/Los_Angeles")).toBe(20);
    expect(localHourIn(at0300utc, "Not/AZone")).toBe(3);
  });
});

describe("fanOutOrgJobs (per-org jobs with deterministic ids)", () => {
  const deps = {
    activeOrgs: {
      listActiveOrgs: async () => [{ organizationId: "org-a" }, { organizationId: "org-b" }],
    },
    now: () => new Date(NOW),
  } as unknown as M15WorkerDeps;

  it("enqueues one org job per active org for an always-on cron, with a hour-bucketed jobId", async () => {
    const addBulk = vi.fn(async (_jobs: unknown) => []);
    const due = await fanOutOrgJobs(deps, "supervisoryOverdue", { addBulk });
    expect(due).toEqual(["org-a", "org-b"]);
    const jobs = (addBulk.mock.calls[0] as unknown[])[0] as {
      name: string;
      data: unknown;
      opts: { jobId: string };
    }[];
    expect(jobs.map((j) => j.name)).toEqual(["org", "org"]);
    expect(jobs[0]?.opts.jobId).toBe("supervisoryOverdue__org-a__2026-10-05T03");
  });

  it("produces identical jobIds on a re-run in the same hour (BullMQ dedupes the re-add)", async () => {
    const ids = async () => {
      const addBulk = vi.fn(async (_jobs: unknown) => []);
      await fanOutOrgJobs(deps, "supervisoryOverdue", { addBulk });
      return ((addBulk.mock.calls[0] as unknown[])[0] as { opts: { jobId: string } }[]).map(
        (j) => j.opts.jobId,
      );
    };
    expect(await ids()).toEqual(await ids());
  });
});

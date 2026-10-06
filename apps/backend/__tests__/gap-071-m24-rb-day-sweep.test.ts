/**
 * GAP-071 — pure derivation of rb_day rows + the cron fan-out isolation. No DB (the live suite covers the
 * Drizzle store under RLS).
 */
import { describe, expect, it, vi } from "vitest";
import { forEachActiveOrg } from "../src/modules/24-billing-medicaid/jobs/index";
import {
  M24_ELIGIBILITY_STALE_ALERT,
  runEligibilityStaleWatchdog,
} from "../src/modules/24-billing-medicaid/jobs/m24-jobs";
import {
  type RbSweepLocPeriod,
  deriveRbDays,
} from "../src/modules/24-billing-medicaid/jobs/rb-day-sweep";
import { buildM24RbDayConsumers } from "../src/modules/24-billing-medicaid/outbox-consumers/m24-rb-day-consumers";

const DAY = 86_400_000;
const d = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
const NF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const arrangement = {
  nfFacilityMdmId: NF,
  nfPerDiemRoutineCents: 20000,
  nfPerDiemRespCents: 25000,
  nfPerDiemGipCents: 80000,
};
const period = (
  periodId: string,
  levelOfCare: RbSweepLocPeriod["levelOfCare"],
  from: string,
  to: string | null,
  facilityId: string | null = null,
): RbSweepLocPeriod => ({
  periodId,
  levelOfCare,
  effectiveAt: new Date(`${from}T08:00:00.000Z`),
  endedAt: to ? new Date(`${to}T08:00:00.000Z`) : null,
  facilityId,
});

describe("deriveRbDays", () => {
  it("marks RHC/CHC days billable at the routine rate with the covering period snapshot", () => {
    const out = deriveRbDays({
      arrangement,
      periods: [period("p1", "routine_home_care", "2026-05-01", null)],
      fromDay: d("2026-05-01"),
      toDay: d("2026-05-03"),
      existingDays: new Set(),
    });
    expect(out.map((r) => r.serviceDate.toISOString().slice(0, 10))).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ]);
    expect(out.every((r) => r.status === "billable" && r.perDiemCentsSnapshot === 20000)).toBe(
      true,
    );
    expect(out.every((r) => r.locOfDay === "RHC" && r.locPeriodIdSnapshot === "p1")).toBe(true);
  });

  it("excludes GIP and respite days (mid-month transitions), the new period winning on its start day", () => {
    const out = deriveRbDays({
      arrangement,
      periods: [
        period("p1", "routine_home_care", "2026-05-01", "2026-05-03"),
        period("p2", "general_inpatient_care", "2026-05-03", "2026-05-05"),
        period(
          "p3",
          "inpatient_respite_care",
          "2026-05-05",
          "2026-05-06",
          "bbbbbbbb-0000-0000-0000-000000000000",
        ),
        period("p4", "routine_home_care", "2026-05-06", null),
      ],
      fromDay: d("2026-05-02"),
      toDay: d("2026-05-06"),
      existingDays: new Set(),
    });
    expect(
      out.map((r) => [r.serviceDate.toISOString().slice(0, 10), r.status, r.locOfDay]),
    ).toEqual([
      ["2026-05-02", "billable", "RHC"],
      ["2026-05-03", "excluded", "GIP"],
      ["2026-05-04", "excluded", "GIP"],
      ["2026-05-05", "excluded", "IRC"],
      ["2026-05-06", "billable", "RHC"],
    ]);
    expect(out[3]?.exclusionReason).toBe("respite at non-arranged facility");
  });

  it("skips days that already hold a row (idempotent; voided/excluded stay terminal) and LOC-less days", () => {
    const out = deriveRbDays({
      arrangement,
      periods: [period("p1", "routine_home_care", "2026-05-02", null)],
      fromDay: d("2026-05-01"),
      toDay: d("2026-05-04"),
      existingDays: new Set([d("2026-05-03")]),
    });
    expect(out.map((r) => r.serviceDate.getTime())).toEqual([
      d("2026-05-02"),
      d("2026-05-02") + 2 * DAY,
    ]);
  });
});

describe("forEachActiveOrg", () => {
  it("runs every org even when one fails, then throws so the tick is recorded failed", async () => {
    const seen: string[] = [];
    const log = { error: vi.fn() };
    const activeOrgs = {
      listActiveOrgs: async () => [{ organizationId: "o1" }, { organizationId: "o2" }],
    };
    await expect(
      forEachActiveOrg(activeOrgs, log, "t", async (org) => {
        seen.push(org);
        if (org === "o1") throw new Error("boom");
      }),
    ).rejects.toThrow("t: 1 org(s) failed");
    expect(seen).toEqual(["o1", "o2"]);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe("runEligibilityStaleWatchdog alerting", () => {
  const store = (
    findings: { patientId: string; lastCheckedAt: string; providerEntityId: string | null }[],
  ) => ({
    staleEligibilityCount: async () => findings.length,
    staleEligibilityFindings: async () => findings,
  });

  it("dispatches one deduped alert per stale patient and none when nothing is stale", async () => {
    const dispatch = vi.fn(async () => undefined);
    const f = [
      { patientId: "p1", lastCheckedAt: "2026-04-01T00:00:00.000Z", providerEntityId: "pe1" },
    ];
    const r = await runEligibilityStaleWatchdog(store(f), "o1", "2026-06-01", { dispatch });
    expect(r).toEqual({ stale: 1, alerted: 1 });
    expect(dispatch).toHaveBeenCalledWith({
      eventType: M24_ELIGIBILITY_STALE_ALERT,
      organizationId: "o1",
      severity: "warn",
      correlationId: "m24-eligibility-stale:o1:p1:2026-04-01T00:00:00.000Z",
      payload: {
        patientId: "p1",
        lastCheckedAt: "2026-04-01T00:00:00.000Z",
        providerEntityId: "pe1",
      },
    });
    dispatch.mockClear();
    await runEligibilityStaleWatchdog(store([]), "o1", "2026-06-01", { dispatch });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("omits providerEntityId from the payload when the check carries none (org-wide fallback applies)", async () => {
    const dispatch = vi.fn(async () => undefined);
    const f = [
      { patientId: "p1", lastCheckedAt: "2026-04-01T00:00:00.000Z", providerEntityId: null },
    ];
    await runEligibilityStaleWatchdog(store(f), "o1", "2026-06-01", { dispatch });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { patientId: "p1", lastCheckedAt: "2026-04-01T00:00:00.000Z" },
      }),
    );
  });

  it("logs and survives a failing alert dispatch (best-effort), still counting the stale patients", async () => {
    const log = { error: vi.fn() };
    const dispatch = vi.fn(async () => {
      throw new Error("m36 down");
    });
    const f = [
      { patientId: "p1", lastCheckedAt: "2026-04-01T00:00:00.000Z", providerEntityId: null },
      { patientId: "p2", lastCheckedAt: "2026-04-02T00:00:00.000Z", providerEntityId: null },
    ];
    const r = await runEligibilityStaleWatchdog(store(f), "o1", "2026-06-01", { dispatch }, log);
    expect(r).toEqual({ stale: 2, alerted: 0 });
    expect(log.error).toHaveBeenCalledTimes(2);
  });
});

describe("m24.rb-day-admission-discharged", () => {
  it("leaves a death discharge to the deceased consumer (day of death stays billable)", async () => {
    const patientIdForAdmission = vi.fn();
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error("db touched");
        },
      },
    );
    const consumers = buildM24RbDayConsumers({
      db: db as never,
      locPeriods: {} as never,
      admissions: { patientIdForAdmission },
    });
    const discharge = consumers.find((c) => c.consumerName === "m24.rb-day-admission-discharged");
    await discharge?.handle({
      id: "e1",
      eventType: "m6.admission.discharged",
      organizationId: "org-1",
      payload: { admissionId: "a1", reason: "death", dischargeDate: "2026-03-10" },
    } as never);
    expect(patientIdForAdmission).not.toHaveBeenCalled();
  });
});

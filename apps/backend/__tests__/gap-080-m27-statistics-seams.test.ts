/**
 * GAP-080 — the pure core of the M27 S-3 statistics sources (the DB reads are proven in
 * `gap-080-m27-statistics-refresh.live.test.ts`): month splitting, level-of-care lookup, the aggregate folding, FTE
 * derivation and the discipline normaliser; and the assembled seams over fake ports.
 */
import type { DbClient } from "@wardenx/db";
import { describe, expect, it, vi } from "vitest";
import { programOfCoverageKind } from "../src/modules/05-patient/seams/payer-programs-for-patients";
import {
  levelOnDay,
  splitSpanByMonth,
} from "../src/modules/06-admission/seams/service-census-for-org";
import {
  buildM27StatisticsSeams,
  buildMonthlyBreakdown,
  canonicalDiscipline,
  fteFromWageRows,
  inclusiveDays,
} from "../src/modules/27-cost-report/jobs/statistics-seams";

const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00.000Z`) / 86_400_000);

describe("splitSpanByMonth", () => {
  it("splits a span across month ends and clips it to the window", () => {
    expect(
      splitSpanByMonth(day("2026-01-30"), day("2026-02-03"), day("2026-01-01"), day("2027-01-01")),
    ).toEqual([
      { month: "2026-01", days: 2 },
      { month: "2026-02", days: 2 },
    ]);
    expect(
      splitSpanByMonth(day("2025-12-20"), day("2026-01-05"), day("2026-01-01"), day("2027-01-01")),
    ).toEqual([{ month: "2026-01", days: 4 }]);
  });

  it("yields nothing for an empty or out-of-window span", () => {
    expect(
      splitSpanByMonth(day("2026-02-01"), day("2026-02-01"), day("2026-01-01"), day("2027-01-01")),
    ).toEqual([]);
    expect(
      splitSpanByMonth(day("2027-02-01"), day("2027-03-01"), day("2026-01-01"), day("2027-01-01")),
    ).toEqual([]);
  });
});

describe("levelOnDay", () => {
  const periods = [
    {
      admissionId: "a",
      patientId: "p",
      levelOfCare: "routine_home_care",
      startDay: 10,
      endDay: 20,
    },
    {
      admissionId: "a",
      patientId: "p",
      levelOfCare: "general_inpatient_care",
      startDay: 20,
      endDay: 30,
    },
  ];
  it("returns the covering period, else the closest earlier one, else routine", () => {
    expect(levelOnDay(periods, "a", 15)).toBe("routine_home_care");
    expect(levelOnDay(periods, "a", 20)).toBe("general_inpatient_care");
    expect(levelOnDay(periods, "a", 45)).toBe("general_inpatient_care");
    expect(levelOnDay(periods, "a", 5)).toBe("routine_home_care");
    expect(levelOnDay(periods, "other", 15)).toBe("routine_home_care");
  });
});

describe("programOfCoverageKind", () => {
  it("maps coverage kinds onto the three S-3 programs", () => {
    expect(programOfCoverageKind("medicare_ffs")).toBe("medicare");
    expect(programOfCoverageKind("medicare_advantage")).toBe("medicare");
    expect(programOfCoverageKind("medicaid")).toBe("medicaid");
    expect(programOfCoverageKind("commercial")).toBe("other");
    expect(programOfCoverageKind("hospice_carve_out")).toBe("other");
  });
});

describe("buildMonthlyBreakdown", () => {
  it("folds per-patient rows into month × level × program cells, counting each beneficiary once", () => {
    const breakdown = buildMonthlyBreakdown(
      {
        days: [
          { patientId: "p1", levelOfCare: "routine_home_care", month: "2026-01", patientDays: 10 },
          { patientId: "p2", levelOfCare: "routine_home_care", month: "2026-01", patientDays: 5 },
          { patientId: "p3", levelOfCare: "routine_home_care", month: "2026-01", patientDays: 7 },
          { patientId: "p1", levelOfCare: "routine_home_care", month: "2026-01", patientDays: 0 },
        ],
        events: [
          {
            kind: "admission",
            patientId: "p1",
            month: "2026-01",
            levelOfCare: "routine_home_care",
          },
          {
            kind: "discharge",
            patientId: "p2",
            month: "2026-01",
            levelOfCare: "routine_home_care",
            deathSetting: "facility",
          },
          {
            kind: "discharge",
            patientId: "p3",
            month: "2026-01",
            levelOfCare: "routine_home_care",
          },
        ],
      },
      (id) => (id === "p3" ? "medicaid" : "medicare"),
    );
    expect(breakdown["2026-01"]?.routine_home_care).toEqual({
      medicare: {
        patientDays: 15,
        uniqueBeneficiaries: 2,
        admissions: 1,
        discharges: 1,
        deathsBySetting: { facility: 1 },
      },
      medicaid: { patientDays: 7, uniqueBeneficiaries: 1, admissions: 0, discharges: 1 },
    });
  });

  it("is empty for an empty census", () => {
    expect(buildMonthlyBreakdown({ days: [], events: [] }, () => "other")).toEqual({});
  });
});

describe("canonicalDiscipline / fteFromWageRows", () => {
  it("normalises payroll labels onto the clinical discipline codes", () => {
    expect(canonicalDiscipline(" Registered Nurse ")).toBe("rn");
    expect(canonicalDiscipline("LVN")).toBe("lpn");
    expect(canonicalDiscipline("Home Health Aide")).toBe("chha");
    expect(canonicalDiscipline("Social Worker")).toBe("msw");
    expect(canonicalDiscipline("Chaplain")).toBe("chaplain");
    expect(canonicalDiscipline("Finance clerk")).toBe("other");
  });

  it("derives FTE as paid hours over a year of 2,080 hours, pro-rated to the fiscal window", () => {
    const rows = [
      { discipline: "RN", paidHours: 2080 },
      { discipline: "Registered Nurse", paidHours: 1040 },
      { discipline: "Aide", paidHours: Number.NaN },
    ];
    expect(fteFromWageRows(rows, 365)).toEqual({ rn: 1.5, chha: 0 });
    // a half-year window needs half the hours per FTE
    expect(fteFromWageRows([{ discipline: "RN", paidHours: 1040 }], 182.5)).toEqual({ rn: 1 });
  });

  it("counts fiscal days inclusively", () => {
    expect(inclusiveDays("2026-01-01", "2026-12-31")).toBe(365);
    expect(inclusiveDays("2026-01-01", "2026-01-01")).toBe(1);
  });
});

describe("buildM27StatisticsSeams over ports", () => {
  const scope = {
    organizationId: "org",
    costReportId: "cr",
    providerEntityId: "pe",
    fiscalYearStartDate: "2026-01-01T00:00:00.000Z",
    fiscalYearEndDate: "2026-12-31",
  };

  it("hands the entity + fiscal window to every source and looks programs up as of the earlier of window-end / today", async () => {
    const serviceCensus = vi.fn(async () => ({
      days: [
        { patientId: "p1", levelOfCare: "routine_home_care", month: "2026-01", patientDays: 3 },
      ],
      events: [],
    }));
    const payerPrograms = vi.fn(async () => new Map([["p1", "medicare"]]));
    const visitCounts = vi.fn(async () => ({ rn: 2 }));
    const bereavementCensus = vi.fn(async () => ({
      contactsCount: 1,
      visitsCount: 2,
      mailedContactsCount: 3,
    }));
    const seams = buildM27StatisticsSeams({
      db: {} as DbClient,
      serviceCensus,
      payerPrograms,
      visitCounts,
      bereavementCensus,
      now: () => new Date("2026-03-31T12:00:00.000Z"),
    });

    const breakdown = await seams.serviceMonthlyBreakdown(scope);
    expect(breakdown["2026-01"]?.routine_home_care?.medicare?.patientDays).toBe(3);
    expect(serviceCensus).toHaveBeenCalledWith("org", {
      providerEntityId: "pe",
      from: "2026-01-01",
      to: "2026-12-31",
      asOf: new Date("2026-03-31T12:00:00.000Z"),
    });
    expect(payerPrograms).toHaveBeenCalledWith("org", ["p1"], "2026-03-31");

    await expect(seams.visitCountsByDiscipline(scope)).resolves.toEqual({ rn: 2 });
    expect(visitCounts).toHaveBeenCalledWith("org", {
      providerEntityId: "pe",
      from: "2026-01-01",
      to: "2026-12-31",
    });
    await expect(seams.bereavementCensus(scope)).resolves.toEqual({
      contactsCount: 1,
      visitsCount: 2,
      mailedContactsCount: 3,
    });
  });

  it("answers an empty FTE map when the scope names no cost report", async () => {
    const seams = buildM27StatisticsSeams({
      db: {} as DbClient,
      serviceCensus: async () => ({ days: [], events: [] }),
      payerPrograms: async () => new Map(),
      visitCounts: async () => ({}),
      bereavementCensus: async () => ({ contactsCount: 0, visitsCount: 0, mailedContactsCount: 0 }),
    });
    await expect(seams.fteByDiscipline({ ...scope, costReportId: undefined })).resolves.toEqual({});
  });
});

// FY2027 SSVI — the M30 recompute input resolvers (ssvi-resolvers.ts) over fake seams, end to end through the
// pure calculators, plus the M6 DischargeReader `ssviDischargeCounts` reduction over a fake scoped db.
import type { DbClient } from "@wardenx/db";
import {
  FORWARD_SEAM_UNAVAILABLE,
  type MeasureRegistration,
  buildMeasureRegistry,
  computeSsviMetric01,
  computeSsviMetric02,
  computeSsviMetric03,
  computeSsviMetric04,
  computeSsviMetric05,
  computeSsviMetric07,
  computeSsviMetric08,
  computeSsviMetric09,
  computeSsviScore,
  isDataUnavailable,
  ssviPointsOf,
} from "@wardenx/quality";
import { describe, expect, it } from "vitest";
import { createDischargeReader } from "../src/modules/06-admission/index";
import {
  isSsviMeasureCode,
  resolveSsviMeasureInput,
  ssviFiscalYearOf,
} from "../src/modules/30-quality/jobs/ssvi-resolvers";

const REG = buildMeasureRegistry();
const REQUEST = (code: string) => ({
  registration: REG.get(code) as MeasureRegistration,
  organizationId: "org-1",
  providerEntityId: "pe-1",
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-04-01T00:00:00.000Z",
});

function seams(overrides: Record<string, unknown> = {}) {
  const fail = (name: string) => () => {
    throw new Error(`${name} not expected on this path`);
  };
  return {
    levelOfCarePeriodReader: {
      chcOrGipCoverageCounts: async () => ({ numerator: 0, denominator: 12 }),
      levelOfCareDaySpans: async () => [
        {
          admissionId: "a1",
          levelOfCare: "routine_home_care",
          from: "2026-01-01",
          to: "2026-01-11",
        },
      ],
      electionPeriodSpans: fail("electionPeriodSpans"),
    },
    dischargeReader: {
      liveDischargeTimingCounts: fail("liveDischargeTimingCounts"),
      ssviDischargeCounts: async () => ({
        totalDischarges: 20,
        liveDischarges: 10,
        dischargesWithLosOver180: 7,
        liveDischargesReadmittedWithin7Days: 2,
      }),
    },
    deathDischargeReader: {
      listDeathDischargesInPeriod: async () => [
        {
          patientId: "p1",
          admissionId: "a1",
          deathAt: "2026-01-11T09:00:00.000Z",
          source: "internal_clinician_recorded" as const,
        },
      ],
    },
    encounters: {
      signedEncountersForPatientSince: fail("signedEncountersForPatientSince"),
      renderPayloadFor: fail("renderPayloadFor"),
      lateEntryCountsForOrg: fail("lateEntryCountsForOrg"),
      skilledNursingDayTotalsForOrg: async () => [],
      skilledVisitDaysForOrg: async () => [{ admissionId: "a1", serviceDate: "2026-01-10" }],
    },
    billing: {
      claimLineRollup: async () => ({
        totalPatientDays: 120,
        rhcDays: 100,
        chcDays: 10,
        ircDays: 5,
        gipDays: 5,
        claimLineCount: 9,
        rhcNursingFacilityDays: 45,
        isForwardSeamDenyStub: false as const,
      }),
      patientDays: fail("patientDays"),
    },
    values: { findCurrent: async () => null },
    ...overrides,
  } as never;
}

describe("SSVI resolvers → calculators", () => {
  it("routes every ssvi_* code and nothing else", () => {
    expect(isSsviMeasureCode("ssvi_metric_01")).toBe(true);
    expect(isSsviMeasureCode("ssvi_composite")).toBe(true);
    expect(isSsviMeasureCode("hci_indicator_01")).toBe(false);
    expect(ssviFiscalYearOf("2026-10-01T00:00:00.000Z")).toBe(2027);
    expect(ssviFiscalYearOf("2026-04-01T00:00:00.000Z")).toBe(2026);
  });

  it("metric 1 reads the HCI-1 aggregate: no CHC/GIP in 12 elections earns the point", async () => {
    const input = await resolveSsviMeasureInput(REQUEST("ssvi_metric_01"), seams());
    expect(ssviPointsOf(computeSsviMetric01(input as never))).toBe(1);
  });

  it("metric 2 reads billed RHC days by site of service (45% in NF/SNF earns the point)", async () => {
    const input = await resolveSsviMeasureInput(REQUEST("ssvi_metric_02"), seams());
    expect(input).toMatchObject({ totalRhcDays: 100, rhcDaysInNursingFacility: 45 });
    expect(ssviPointsOf(computeSsviMetric02(input as never))).toBe(1);
  });

  it("metric 2 SUPPRESSES (0/0) when the M23 seam is not registered, never a zero share", async () => {
    const input = await resolveSsviMeasureInput(
      REQUEST("ssvi_metric_02"),
      seams({
        billing: {
          claimLineRollup: async () => FORWARD_SEAM_UNAVAILABLE,
          patientDays: async () => FORWARD_SEAM_UNAVAILABLE,
        },
      }),
    );
    expect(computeSsviMetric02(input as never).bandColor).toBe("insufficient_n");
  });

  it("metric 3 joins the death census, LOC spans and skilled-visit days (visited the day before death)", async () => {
    const input = await resolveSsviMeasureInput(REQUEST("ssvi_metric_03"), seams());
    expect(input).toMatchObject({
      decedentsWithLastTwoDaysRhc: 1,
      decedentsWithSkilledVisitInLastTwoDays: 1,
    });
    expect(ssviPointsOf(computeSsviMetric03(input as never))).toBe(0);
  });

  it("metrics 4/5/8 shape the ONE M6 discharge aggregate", async () => {
    const m4 = await resolveSsviMeasureInput(REQUEST("ssvi_metric_04"), seams());
    expect(ssviPointsOf(computeSsviMetric04(m4 as never))).toBe(1); // 50% ≥ 47.5%
    const m5 = await resolveSsviMeasureInput(REQUEST("ssvi_metric_05"), seams());
    expect(ssviPointsOf(computeSsviMetric05(m5 as never))).toBe(1); // 35% ≥ 33.2%
    const m8 = await resolveSsviMeasureInput(REQUEST("ssvi_metric_08"), seams());
    expect(ssviPointsOf(computeSsviMetric08(m8 as never))).toBe(1); // 20% ≥ 15%
  });

  it("metric 7: the Saturday 2026-01-10 visit is 1 of 10 RHC days (10% > 4.8%) → no point", async () => {
    const input = await resolveSsviMeasureInput(REQUEST("ssvi_metric_07"), seams());
    expect(input).toMatchObject({ totalRhcDays: 10, weekendRhcDaysWithSkilledVisit: 1 });
    expect(ssviPointsOf(computeSsviMetric07(input as never))).toBe(0);
    const noVisits = await resolveSsviMeasureInput(
      REQUEST("ssvi_metric_07"),
      seams({
        encounters: {
          skilledVisitDaysForOrg: async () => [],
          skilledNursingDayTotalsForOrg: async () => [],
        },
      }),
    );
    expect(ssviPointsOf(computeSsviMetric07(noVisits as never))).toBe(1);
  });

  it("metric 9 resolves to the declared absence (no seam read)", async () => {
    const input = await resolveSsviMeasureInput(REQUEST("ssvi_metric_09"), seams());
    expect(isDataUnavailable(computeSsviMetric09(input as never))).toBe(true);
  });

  it("the composite reads the nine persisted values and is withheld while metric 9 is unavailable", async () => {
    const m9Unavailable = computeSsviMetric09(
      (await resolveSsviMeasureInput(REQUEST("ssvi_metric_09"), seams())) as never,
    );
    const metricRow = (code: string) => {
      if (code === "ssvi_metric_09")
        return {
          numerator: 0,
          denominator: 0,
          ratio: null,
          thresholdMet: null,
          computationSnapshot: m9Unavailable.computationSnapshot,
        };
      return {
        numerator: 1,
        denominator: 2,
        ratio: "0.5000",
        thresholdMet: false,
        computationSnapshot: { ssviPoints: 1 },
      };
    };
    const input = await resolveSsviMeasureInput(
      REQUEST("ssvi_composite"),
      seams({ values: { findCurrent: async (code: string) => metricRow(code) } }),
    );
    const total = computeSsviScore(input as never);
    expect(isDataUnavailable(total)).toBe(true);
    expect(total.computationSnapshot.partialScoreLowerBound).toBe(8);
    expect(total.computationSnapshot.maxPossibleScore).toBe(16);
  });
});

// ── M6 DischargeReader.ssviDischargeCounts over a fake scoped db ──
interface DischargeRow {
  admissionId: string;
  dischargeType: string;
  effectiveAt: string;
  admissionAt: Date | null;
  patientId: string;
}
interface AdmissionRow {
  id: string;
  patientId: string;
  admissionAt: Date | null;
}
function fakeDb(discharges: DischargeRow[], admissions: AdmissionRow[]): DbClient {
  const tx = {
    async execute() {
      return undefined;
    },
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return { where: () => Promise.resolve(discharges) };
            },
            where: () => Promise.resolve(admissions),
          };
        },
      };
    },
  };
  return {
    async transaction<R>(fn: (t: typeof tx) => Promise<R>): Promise<R> {
      return fn(tx);
    },
  } as unknown as DbClient;
}

describe("DischargeReader.ssviDischargeCounts (SSVI metrics 4/5/8)", () => {
  it("counts live discharges, LOS > 180 across ALL types, and same-hospice readmissions within 7 days", async () => {
    const db = fakeDb(
      [
        // death after 200 days — long stay counts, not live
        {
          admissionId: "a1",
          dischargeType: "death",
          effectiveAt: "2026-02-01",
          admissionAt: new Date("2025-07-16T12:00:00Z"),
          patientId: "p1",
        },
        // live (revocation) after exactly 180 days — NOT over 180; readmitted 7 days later → counts
        {
          admissionId: "a2",
          dischargeType: "revocation",
          effectiveAt: "2026-02-01",
          admissionAt: new Date("2025-08-05T00:00:00Z"),
          patientId: "p2",
        },
        // live transfer, readmitted 8 days later → does NOT count
        {
          admissionId: "a3",
          dischargeType: "transfer",
          effectiveAt: "2026-02-01",
          admissionAt: new Date("2026-01-20T00:00:00Z"),
          patientId: "p3",
        },
      ],
      [
        { id: "a2", patientId: "p2", admissionAt: new Date("2025-08-05T00:00:00Z") },
        { id: "a2b", patientId: "p2", admissionAt: new Date("2026-02-08T10:00:00Z") },
        { id: "a3", patientId: "p3", admissionAt: new Date("2026-01-20T00:00:00Z") },
        { id: "a3b", patientId: "p3", admissionAt: new Date("2026-02-09T10:00:00Z") },
      ],
    );
    const out = await createDischargeReader(db).ssviDischargeCounts("org-1", {
      from: "2026-01-01",
      to: "2026-04-01",
    });
    expect(out).toEqual({
      totalDischarges: 3,
      liveDischarges: 2,
      dischargesWithLosOver180: 1,
      liveDischargesReadmittedWithin7Days: 1,
    });
  });
});

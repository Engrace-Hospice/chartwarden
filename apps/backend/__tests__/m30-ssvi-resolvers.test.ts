// FY2027 SSVI — the M30 recompute input resolvers (ssvi-resolvers.ts) over fake seams, end to end through the
// pure calculators, plus the M6 DischargeReader `ssviDischargeCounts` reduction over a fake scoped db.
import type { DbClient } from "@chartwarden/db";
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
} from "@chartwarden/quality";
import { describe, expect, it } from "vitest";
import { createDischargeReader } from "../src/modules/06-admission/index";
import {
  isSsviMeasureCode,
  resolveSsviMeasureInput,
  ssviFiscalYearOf,
} from "../src/modules/30-quality/jobs/ssvi-resolvers";

const REG = buildMeasureRegistry();
/** The calculator version the catalog says a measure's CURRENT rows carry. */
const currentVersion = (code: string): string =>
  (REG.get(code) as MeasureRegistration).calculatorVersion;
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
        dischargesWithLos180OrMore: 7,
        // Metric 8's live population also counts transfers (CMS): 2 transfers on top of the 10 live discharges.
        liveDischargesIncludingTransfers: 12,
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
    expect(ssviPointsOf(computeSsviMetric04(m4 as never))).toBe(1); // 50% ≥ 47.0%
    const m5 = await resolveSsviMeasureInput(REQUEST("ssvi_metric_05"), seams());
    expect(ssviPointsOf(computeSsviMetric05(m5 as never))).toBe(1); // 35% ≥ 33.3%
    // Metric 8 divides by the live population INCLUDING transfers (12), so 2/12 = 16.7% < 18.2% earns no point;
    // dividing by the 10 non-transfer live discharges (20%) would wrongly earn one.
    const m8 = await resolveSsviMeasureInput(REQUEST("ssvi_metric_08"), seams());
    expect(m8).toMatchObject({ liveDischarges: 12, liveDischargesReadmittedWithin7Days: 2 });
    expect(ssviPointsOf(computeSsviMetric08(m8 as never))).toBe(0);
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
      const calculatorVersion = currentVersion(code);
      if (code === "ssvi_metric_09")
        return {
          numerator: 0,
          denominator: 0,
          ratio: null,
          thresholdMet: null,
          computationSnapshot: m9Unavailable.computationSnapshot,
          calculatorVersion,
        };
      return {
        numerator: 1,
        denominator: 2,
        ratio: "0.5000",
        thresholdMet: false,
        computationSnapshot: { ssviPoints: 1 },
        calculatorVersion,
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

  it("the composite treats a metric row stamped with an OLDER calculator version as not yet computed, never as stale points", async () => {
    const row = (code: string) => ({
      numerator: 1,
      denominator: 2,
      ratio: "0.5000",
      thresholdMet: false,
      computationSnapshot: { ssviPoints: 1 },
      // metric 3's current row predates its definition fix (0.1.0 → 0.2.0); the others are current
      calculatorVersion: code === "ssvi_metric_03" ? "0.1.0" : currentVersion(code),
    });
    const input = (await resolveSsviMeasureInput(
      REQUEST("ssvi_composite"),
      seams({ values: { findCurrent: async (code: string) => row(code) } }),
    )) as { metrics: Record<string, unknown> };
    expect(input.metrics.metric_03).toBeNull();
    expect(input.metrics.metric_04).not.toBeNull();
    const total = computeSsviScore(input as never);
    expect(total.computationSnapshot.notYetComputedMetrics).toEqual(["metric_03"]);
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
  it("counts live discharges and LOS ≥ 180 over NON-transfer discharges, and readmissions within 7 days over live INCLUDING transfers (CMS)", async () => {
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
        // live (revocation) after exactly 180 days — CMS counts 180 days OR MORE; readmitted 7 days later → counts
        {
          admissionId: "a2",
          dischargeType: "revocation",
          effectiveAt: "2026-02-01",
          admissionAt: new Date("2025-08-05T00:00:00Z"),
          patientId: "p2",
        },
        // transfer (CMS status 50/51): NOT a discharge for metrics 4/5, but a live discharge for metric 8;
        // readmitted 8 days later → does NOT count as a return
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
      totalDischarges: 2,
      liveDischarges: 1,
      dischargesWithLos180OrMore: 2,
      liveDischargesIncludingTransfers: 2,
      liveDischargesReadmittedWithin7Days: 1,
    });
  });

  it("a LONG-STAY transfer is no metric-5 discharge, and a transfer that returns within 7 days counts for metric 8", async () => {
    const db = fakeDb(
      [
        // transfer after 201 days: excluded from metrics 4/5 entirely (CMS status 50/51)
        {
          admissionId: "t1",
          dischargeType: "transfer",
          effectiveAt: "2026-02-01",
          admissionAt: new Date("2025-07-15T00:00:00Z"),
          patientId: "pt1",
        },
      ],
      [
        { id: "t1", patientId: "pt1", admissionAt: new Date("2025-07-15T00:00:00Z") },
        // the same patient is back 3 days after the transfer: a return CMS counts for metric 8
        { id: "t1b", patientId: "pt1", admissionAt: new Date("2026-02-04T10:00:00Z") },
      ],
    );
    const out = await createDischargeReader(db).ssviDischargeCounts("org-1", {
      from: "2026-01-01",
      to: "2026-04-01",
    });
    expect(out).toEqual({
      totalDischarges: 0,
      liveDischarges: 0,
      dischargesWithLos180OrMore: 0,
      liveDischargesIncludingTransfers: 1,
      liveDischargesReadmittedWithin7Days: 1,
    });
  });
});

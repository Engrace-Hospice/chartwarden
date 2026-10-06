// FY2027 SSVI (CMS-1851-F Table 9) — per-metric calculators, the 0-16 composite, the per-FY thresholds, the
// metric-9 unavailability, the day reductions, and the catalog/registration wiring.
import { describe, expect, it } from "vitest";
import {
  HCI_UNAVAILABLE_MEASURE_CODES,
  MEASURE_CATALOG,
  type QualityMeasureValueResult,
  SSVI_INTERNAL_ESTIMATE_NOTICE,
  SSVI_METRIC_MEASURE_CODES,
  SSVI_OUTLIER_SCORE,
  SSVI_THRESHOLDS_FY2025_DATA as T,
  SSVI_UNAVAILABLE_MEASURE_CODES,
  SSVI_UNAVAILABLE_METRICS,
  type SsviMetricKey,
  buildMeasureRegistry,
  computeSsviMetric01,
  computeSsviMetric02,
  computeSsviMetric03,
  computeSsviMetric04,
  computeSsviMetric05,
  computeSsviMetric06,
  computeSsviMetric07,
  computeSsviMetric08,
  computeSsviMetric09,
  computeSsviScore,
  isDataUnavailable,
  listMeasureCatalog,
  ssviLastTwoDaysRhcWithVisit,
  ssviPointsOf,
  ssviSpendingPoints,
  ssviThresholdsFor,
  ssviWeekendRhcDaysWithSkilledVisit,
} from "../src";

const BASE = {
  organizationId: "org-1",
  providerEntityId: "pe-1",
  periodStart: "2025-10-01T00:00:00.000Z",
  periodEnd: "2026-10-01T00:00:00.000Z",
};
const r = T.metrics;

describe("SSVI thresholds (FY2025 data, published with the FY2027 rule)", () => {
  it("carries the Table 9 cuts exactly", () => {
    expect(r.metric_02).toMatchObject({ direction: "gte", value: 0.4 });
    expect(r.metric_03).toMatchObject({ direction: "lte", value: 0.857 });
    expect(r.metric_04).toMatchObject({ direction: "gte", value: 0.475 });
    expect(r.metric_05).toMatchObject({ direction: "gte", value: 0.332 });
    expect(r.metric_06).toMatchObject({ direction: "lte", value: 9.8 });
    expect(r.metric_07).toMatchObject({ direction: "lte", value: 0.048 });
    expect(r.metric_08).toMatchObject({ direction: "gte", value: 0.15 });
    expect(T.spendingOctileUpperBoundsCents).toEqual([
      635_284, 2_061_210, 4_291_179, 7_680_105, 13_344_080, 24_612_310, 51_720_440,
    ]);
    expect(T.maxScore).toBe(16);
    expect(T.outlierScore).toBe(13);
  });

  it("is a per-FY table: a later FY falls back to the latest published cut, an earlier one to the earliest", () => {
    expect(ssviThresholdsFor(2025)).toBe(T);
    expect(ssviThresholdsFor(2027).dataFiscalYear).toBe(2025);
    expect(ssviThresholdsFor(2020).dataFiscalYear).toBe(2025);
  });

  it("scores non-hospice spending by octile, each band's lower bound exclusive; $0 scores 0", () => {
    const b = T.spendingOctileUpperBoundsCents;
    expect(ssviSpendingPoints(0, b)).toBe(0);
    expect(ssviSpendingPoints(1, b)).toBe(1);
    expect(ssviSpendingPoints(635_284, b)).toBe(1);
    expect(ssviSpendingPoints(635_285, b)).toBe(2);
    expect(ssviSpendingPoints(2_061_210, b)).toBe(2);
    expect(ssviSpendingPoints(51_720_440, b)).toBe(7);
    expect(ssviSpendingPoints(51_720_441, b)).toBe(8);
  });
});

describe("SSVI binary metrics — the point is earned on the CONCERN side, inclusive at the cut", () => {
  it("metric 1: a point only when NO CHC and NO GIP was provided", () => {
    const none = computeSsviMetric01({
      ...BASE,
      totalElectionPeriods: 40,
      periodsWithChcOrGipDay: 0,
      rule: r.metric_01,
    });
    expect(ssviPointsOf(none)).toBe(1);
    expect(none.bandColor).toBe("red");
    expect(none.thresholdMet).toBe(false);
    const some = computeSsviMetric01({
      ...BASE,
      totalElectionPeriods: 40,
      periodsWithChcOrGipDay: 1,
      rule: r.metric_01,
    });
    expect(ssviPointsOf(some)).toBe(0);
    expect(some.bandColor).toBe("green");
  });

  it("metric 2: ≥ 40% of RHC days in a NF/SNF", () => {
    const at = computeSsviMetric02({
      ...BASE,
      totalRhcDays: 100,
      rhcDaysInNursingFacility: 40,
      rule: r.metric_02,
    });
    expect(ssviPointsOf(at)).toBe(1);
    const below = computeSsviMetric02({
      ...BASE,
      totalRhcDays: 100,
      rhcDaysInNursingFacility: 39,
      rule: r.metric_02,
    });
    expect(ssviPointsOf(below)).toBe(0);
  });

  it("metric 3: ≤ 85.7% of decedents with a skilled visit in the last two RHC days", () => {
    const low = computeSsviMetric03({
      ...BASE,
      decedentsWithLastTwoDaysRhc: 1000,
      decedentsWithSkilledVisitInLastTwoDays: 857,
      rule: r.metric_03,
    });
    expect(ssviPointsOf(low)).toBe(1);
    const ok = computeSsviMetric03({
      ...BASE,
      decedentsWithLastTwoDaysRhc: 1000,
      decedentsWithSkilledVisitInLastTwoDays: 858,
      rule: r.metric_03,
    });
    expect(ssviPointsOf(ok)).toBe(0);
  });

  it("metric 4: ≥ 47.5% live discharges", () => {
    const pt = (live: number) =>
      ssviPointsOf(
        computeSsviMetric04({ ...BASE, totalDischarges: 200, liveDischarges: live, rule: r.metric_04 }),
      );
    expect(pt(95)).toBe(1);
    expect(pt(94)).toBe(0);
  });

  it("metric 5: ≥ 33.2% of discharges with LOS > 180 days", () => {
    const pt = (n: number) =>
      ssviPointsOf(
        computeSsviMetric05({
          ...BASE,
          totalDischarges: 1000,
          dischargesWithLosOver180: n,
          rule: r.metric_05,
        }),
      );
    expect(pt(332)).toBe(1);
    expect(pt(331)).toBe(0);
  });

  it("metric 6: ≤ 9.8 skilled-nursing minutes per RHC day, decided in minutes, stored ÷ 1440", () => {
    const low = computeSsviMetric06({
      ...BASE,
      totalRhcDays: 10,
      skilledNursingMinutesOnRhcDays: 98,
      rule: r.metric_06,
    });
    expect(ssviPointsOf(low)).toBe(1);
    expect(low.rate).toBeCloseTo(9.8 / 1440);
    expect(low.thresholdValue).toBeCloseTo(9.8 / 1440);
    expect(low.computationSnapshot.meanSkilledNursingMinutesPerRhcDay).toBeCloseTo(9.8);
    const ok = computeSsviMetric06({
      ...BASE,
      totalRhcDays: 10,
      skilledNursingMinutesOnRhcDays: 99,
      rule: r.metric_06,
    });
    expect(ssviPointsOf(ok)).toBe(0);
  });

  it("metric 7: ≤ 4.8% of RHC days are weekend days with a skilled visit", () => {
    const pt = (n: number) =>
      ssviPointsOf(
        computeSsviMetric07({
          ...BASE,
          totalRhcDays: 1000,
          weekendRhcDaysWithSkilledVisit: n,
          rule: r.metric_07,
        }),
      );
    expect(pt(48)).toBe(1);
    expect(pt(49)).toBe(0);
  });

  it("metric 8: ≥ 15% of live discharges back within 7 days", () => {
    const pt = (n: number) =>
      ssviPointsOf(
        computeSsviMetric08({
          ...BASE,
          liveDischarges: 100,
          liveDischargesReadmittedWithin7Days: n,
          rule: r.metric_08,
        }),
      );
    expect(pt(15)).toBe(1);
    expect(pt(14)).toBe(0);
  });

  it("an empty population is insufficient_n and earns NO point", () => {
    const empty = computeSsviMetric04({
      ...BASE,
      totalDischarges: 0,
      liveDischarges: 0,
      rule: r.metric_04,
    });
    expect(empty.bandColor).toBe("insufficient_n");
    expect(empty.rate).toBeNull();
    expect(ssviPointsOf(empty)).toBe(0);
  });

  it("every metric snapshot is marked an internal estimate", () => {
    const v = computeSsviMetric01({
      ...BASE,
      totalElectionPeriods: 1,
      periodsWithChcOrGipDay: 1,
      rule: r.metric_01,
    });
    expect(v.computationSnapshot.internalEstimate).toBe(true);
  });
});

describe("SSVI metric 9 — unavailable here, but the octile scoring is real", () => {
  it("suppresses with the declared reason when the input is unavailable", () => {
    const declared = SSVI_UNAVAILABLE_METRICS.ssvi_metric_09;
    const v = computeSsviMetric09({
      ...BASE,
      nonHospiceSpendingCents: 0,
      octileUpperBoundsCents: T.spendingOctileUpperBoundsCents,
      unavailable: declared,
    });
    expect(isDataUnavailable(v)).toBe(true);
    expect(v.rate).toBeNull();
    expect(v.computationSnapshot.unavailableReason).toBe(declared?.reason);
  });

  it("scores 0-8 points when a spending input exists", () => {
    const v = computeSsviMetric09({
      ...BASE,
      nonHospiceSpendingCents: 60_000_000,
      octileUpperBoundsCents: T.spendingOctileUpperBoundsCents,
    });
    expect(ssviPointsOf(v)).toBe(8);
    expect(v.numerator).toBe(8);
    expect(v.denominator).toBe(8);
    expect(v.bandColor).toBe("red");
  });

  it("only metric 9 is declared unavailable, and the SSVI does not retire or alter the HCI declarations", () => {
    expect([...SSVI_UNAVAILABLE_MEASURE_CODES]).toEqual(["ssvi_metric_09"]);
    expect(HCI_UNAVAILABLE_MEASURE_CODES.has("hci_indicator_07")).toBe(true);
  });
});

// ── the composite ──
function binary(points: 0 | 1): QualityMeasureValueResult {
  return computeSsviMetric04({
    ...BASE,
    totalDischarges: 100,
    liveDischarges: points === 1 ? 60 : 10,
    rule: r.metric_04,
  });
}
function spending(cents: number): QualityMeasureValueResult {
  return computeSsviMetric09({
    ...BASE,
    nonHospiceSpendingCents: cents,
    octileUpperBoundsCents: T.spendingOctileUpperBoundsCents,
  });
}
function metrics(
  binaryPoints: readonly (0 | 1)[],
  m9: QualityMeasureValueResult | null,
): Record<SsviMetricKey, QualityMeasureValueResult | null> {
  const keys: SsviMetricKey[] = [
    "metric_01",
    "metric_02",
    "metric_03",
    "metric_04",
    "metric_05",
    "metric_06",
    "metric_07",
    "metric_08",
  ];
  const out = {} as Record<SsviMetricKey, QualityMeasureValueResult | null>;
  keys.forEach((k, i) => {
    out[k] = binary(binaryPoints[i] ?? 0);
  });
  out.metric_09 = m9;
  return out;
}

describe("computeSsviScore — 0-16, outlier at ≥ 13", () => {
  it("sums the eight binary points and the spending octile", () => {
    const v = computeSsviScore({
      metrics: metrics([1, 1, 0, 0, 1, 0, 0, 0], spending(5_000_000)), // 3 + 4
      thresholds: T,
    });
    expect(v.numerator).toBe(7);
    expect(v.denominator).toBe(16);
    expect(v.rate).toBeCloseTo(7 / 16);
    expect(v.thresholdMet).toBe(true);
    expect(v.bandColor).toBe("green");
    expect(v.computationSnapshot.outlier).toBe(false);
    expect(v.computationSnapshot.internalEstimateNotice).toBe(SSVI_INTERNAL_ESTIMATE_NOTICE);
  });

  it("13 is an outlier (inclusive), 12 is not", () => {
    const at = computeSsviScore({
      metrics: metrics([1, 1, 1, 1, 1, 0, 0, 0], spending(60_000_000)), // 5 + 8
      thresholds: T,
    });
    expect(at.numerator).toBe(SSVI_OUTLIER_SCORE);
    expect(at.bandColor).toBe("red");
    expect(at.thresholdMet).toBe(false);
    expect(at.computationSnapshot.outlier).toBe(true);
    const below = computeSsviScore({
      metrics: metrics([1, 1, 1, 1, 0, 0, 0, 0], spending(60_000_000)), // 4 + 8
      thresholds: T,
    });
    expect(below.numerator).toBe(12);
    expect(below.bandColor).toBe("green");
  });

  it("withholds the total while metric 9 is unavailable, recording the lower bound and the maximum", () => {
    const m9 = computeSsviMetric09({
      ...BASE,
      nonHospiceSpendingCents: 0,
      octileUpperBoundsCents: T.spendingOctileUpperBoundsCents,
      unavailable: SSVI_UNAVAILABLE_METRICS.ssvi_metric_09,
    });
    const v = computeSsviScore({ metrics: metrics([1, 1, 1, 0, 0, 0, 0, 0], m9), thresholds: T });
    expect(isDataUnavailable(v)).toBe(true);
    expect(v.rate).toBeNull();
    expect(v.computationSnapshot.partialScoreLowerBound).toBe(3);
    expect(v.computationSnapshot.maxPossibleScore).toBe(11);
    expect(v.computationSnapshot.outlierRegardlessOfMissing).toBe(false);
    expect(v.computationSnapshot.unavailableMetrics).toEqual(["metric_09"]);
  });

  it("withholds (not zeroes) a metric that has not been computed yet", () => {
    const m = metrics([1, 1, 1, 1, 1, 1, 1, 1], spending(60_000_000));
    const v = computeSsviScore({ metrics: { ...m, metric_03: null }, thresholds: T });
    expect(isDataUnavailable(v)).toBe(true);
    expect(v.computationSnapshot.notYetComputedMetrics).toEqual(["metric_03"]);
    expect(v.computationSnapshot.partialScoreLowerBound).toBe(15);
    expect(v.computationSnapshot.outlierRegardlessOfMissing).toBe(true);
  });
});

describe("SSVI day reductions", () => {
  // 2026-01-03 is a Saturday, 2026-01-04 a Sunday.
  const spans = [
    { admissionId: "a1", levelOfCare: "routine_home_care", from: "2026-01-01", to: "2026-01-08" },
    { admissionId: "a2", levelOfCare: "general_inpatient_care", from: "2026-01-01", to: "2026-01-08" },
  ];

  it("metric 7 divides weekend RHC days WITH a skilled visit by ALL RHC days", () => {
    const visits = [
      { admissionId: "a1", serviceDate: "2026-01-03" }, // Saturday RHC → counts
      { admissionId: "a1", serviceDate: "2026-01-05" }, // weekday → no
      { admissionId: "a2", serviceDate: "2026-01-04" }, // Sunday but GIP → no
    ];
    expect(
      ssviWeekendRhcDaysWithSkilledVisit(spans, visits, { from: "2026-01-01", to: "2026-01-08" }),
    ).toEqual({ totalRhcDays: 7, weekendRhcDaysWithSkilledVisit: 1 });
  });

  it("metric 3 needs BOTH last days RHC; the death date inherits the prior day's level when no span covers it", () => {
    const deathSpans = [
      // span ends (exclusive) on the death date — the common discharge shape
      { admissionId: "d1", levelOfCare: "routine_home_care", from: "2026-01-01", to: "2026-01-10" },
      { admissionId: "d2", levelOfCare: "routine_home_care", from: "2026-01-01", to: "2026-01-10" },
      // moved to GIP for the last day → not in the denominator
      { admissionId: "d3", levelOfCare: "routine_home_care", from: "2026-01-01", to: "2026-01-09" },
      { admissionId: "d3", levelOfCare: "general_inpatient_care", from: "2026-01-09", to: "2026-01-11" },
    ];
    const out = ssviLastTwoDaysRhcWithVisit(
      [
        { admissionId: "d1", deathDate: "2026-01-10" },
        { admissionId: "d2", deathDate: "2026-01-10" },
        { admissionId: "d3", deathDate: "2026-01-10" },
      ],
      deathSpans,
      [{ admissionId: "d1", serviceDate: "2026-01-09" }],
    );
    expect(out).toEqual({ decedentsWithLastTwoDaysRhc: 2, decedentsWithSkilledVisitInLastTwoDays: 1 });
  });
});

describe("SSVI catalog + registrations", () => {
  const codes = [...SSVI_METRIC_MEASURE_CODES.map(([, c]) => c), "ssvi_composite"];

  it("registers nine metrics + the total in the ssvi family, activating FY2027", () => {
    const entries = MEASURE_CATALOG.filter((e) => e.family === "ssvi");
    expect(entries.map((e) => e.code).sort()).toEqual([...codes].sort());
    for (const e of entries) {
      expect(e.activatesFy).toBe(2027);
      expect(e.description).toMatch(/internal estimate/);
    }
    expect(listMeasureCatalog(2026).some((e) => e.family === "ssvi")).toBe(false);
    expect(listMeasureCatalog(2027).filter((e) => e.family === "ssvi")).toHaveLength(10);
  });

  it("binds a calculator for every SSVI code, and the HCI family is still fully registered", () => {
    const reg = buildMeasureRegistry();
    for (const code of codes) expect(reg.get(code)?.family).toBe("ssvi");
    expect(reg.get("hci_composite")?.family).toBe("hci");
  });
});

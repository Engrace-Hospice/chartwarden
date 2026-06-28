// @wardenx/quality — M30 measure-CALCULATOR unit tests (§3.1, §3.3, §4.11, §7 WF-03 / W-M30-26).
//
// Exercises the pure measure-calculator suite against synthetic injected populations (no DB, no seam, no
// IO — the M33 `refresh.test.ts` / M34 pure-port idiom): the shared `ratioResult` kernel + banding floor,
// the HCI ten indicators + composite scoring, the §4.11 HVLDL external-source snapshot enrichment +
// Risk-Register flag (W-M30-26), the two FY2028 HOPE-derived TFP measures, a representative subset of the
// fifteen operational calculators, the per-FY threshold tables, the rolling-window period math, and the
// catalog/registry FY-activation gate. Every assertion reads the actual implementation under test.
import {
  // kernel
  type MeasureComputationSnapshot,
  type QualityMeasureValueResult,
  type ThresholdRule,
  INSUFFICIENT_N_MIN_DENOMINATOR,
  evaluateThreshold,
  ratioResult,
  // HCI
  HCI_MID_BAND_SCORE,
  HCI_THRESHOLDS_v2025,
  HCI_THRESHOLDS_v2026,
  computeHciIndicator01,
  computeHciIndicator02,
  computeHciIndicator07,
  computeHciIndicator10,
  computeHciScore,
  // HVLDL
  type HvldlDecedentInput,
  type HvldlExternalSourceBreakdown,
  type HvldlRiskRegisterFlag,
  HVLDL_EXTERNAL_SOURCE_FLAG_FRACTION,
  HVLDL_MIN_QUALIFYING_VISITS,
  HVLDL_QUALIFYING_DISCIPLINES_v2025,
  HVLDL_QUALIFYING_DISCIPLINES_v2028,
  computeHvldl,
  // HOPE-derived
  TFP_FOLLOW_UP_WINDOW_DAYS,
  computeTimelyFollowUpNonPain,
  computeTimelyFollowUpPain,
  // operational subset
  computeComfortKitDeploymentToAdminMinutes,
  computeEvvComplianceRate,
  computeIdgCadenceAdherence,
  computeLateEncounterEntryRate,
  computeMissedDoseRate,
  computeOpioidOnAdmissionRate,
  computeVerbalOrderSignatureOnTime,
  computeVisitOnTimeRate,
  // period math
  rolling12MonthToQuarterWindow,
  priorCompletedQuarterWindow,
  resolvePeriodRule,
  MEASURE_FY_BOUNDARY_v2025,
  // catalog / registry
  MEASURE_CATALOG,
  buildMeasureRegistry,
  listMeasureCatalog,
} from "@wardenx/quality";
import { describe, expect, it } from "vitest";

const EMPTY_SNAPSHOT: MeasureComputationSnapshot = {};

/** Build a synthetic indicator result carrying only the threshold verdict the composite reads. */
function indicatorResult(thresholdMet: boolean | null): QualityMeasureValueResult {
  return {
    numerator: thresholdMet === true ? 1 : 0,
    denominator: 1,
    rate: thresholdMet === null ? null : thresholdMet ? 1 : 0,
    thresholdMet,
    bandColor: thresholdMet === null ? "insufficient_n" : thresholdMet ? "green" : "red",
    computationSnapshot: EMPTY_SNAPSHOT,
  };
}

/** Compose ten indicator results from an ordered list of verdicts (true/false/null). */
function hciIndicators(verdicts: readonly (boolean | null)[]): Parameters<typeof computeHciScore>[0]["indicators"] {
  const keys = [
    "indicator_01",
    "indicator_02",
    "indicator_03",
    "indicator_04",
    "indicator_05",
    "indicator_06",
    "indicator_07",
    "indicator_08",
    "indicator_09",
    "indicator_10",
  ] as const;
  const out = {} as Record<(typeof keys)[number], QualityMeasureValueResult>;
  keys.forEach((k, i) => {
    const v = verdicts[i];
    out[k] = indicatorResult(v === undefined ? false : v);
  });
  return out;
}

const BASE = {
  organizationId: "org-1",
  providerEntityId: "pe-1",
  periodStart: "2025-04-01",
  periodEnd: "2026-04-01",
} as const;

// -----------------------------------------------------------------------------
// result.ts kernel — ratioResult + banding + §7 WF-03 insufficient_n floor
// -----------------------------------------------------------------------------

describe("ratioResult kernel (result.ts)", () => {
  it("computes rate = numerator/denominator and defaults to green with no threshold", () => {
    const r = ratioResult({ numerator: 3, denominator: 4, snapshot: EMPTY_SNAPSHOT });
    expect(r.rate).toBe(0.75);
    expect(r.thresholdMet).toBeNull();
    expect(r.bandColor).toBe("green");
  });

  it("WF-03: a denominator below the reportable floor collapses to insufficient_n / null", () => {
    const r = ratioResult({ numerator: 0, denominator: 0, snapshot: EMPTY_SNAPSHOT });
    expect(r.rate).toBeNull();
    expect(r.thresholdMet).toBeNull();
    expect(r.bandColor).toBe("insufficient_n");
    // even with a threshold supplied, the floor wins — no breach fires.
    const withThreshold = ratioResult({
      numerator: 0,
      denominator: 0,
      threshold: { value: 0.8, direction: "gte" },
      snapshot: EMPTY_SNAPSHOT,
    });
    expect(withThreshold.bandColor).toBe("insufficient_n");
    expect(withThreshold.thresholdMet).toBeNull();
  });

  it("honors an explicit higher minDenominator floor (CMS public-reporting suppression)", () => {
    const r = ratioResult({ numerator: 5, denominator: 9, minDenominator: 10, snapshot: EMPTY_SNAPSHOT });
    expect(r.bandColor).toBe("insufficient_n");
    expect(r.rate).toBeNull();
    // at/above the floor it computes normally.
    const ok = ratioResult({ numerator: 5, denominator: 10, minDenominator: 10, snapshot: EMPTY_SNAPSHOT });
    expect(ok.rate).toBe(0.5);
    expect(ok.bandColor).toBe("green");
  });

  it("default floor is 1 (a single-member denominator is reportable)", () => {
    expect(INSUFFICIENT_N_MIN_DENOMINATOR).toBe(1);
    const r = ratioResult({ numerator: 1, denominator: 1, snapshot: EMPTY_SNAPSHOT });
    expect(r.bandColor).not.toBe("insufficient_n");
    expect(r.rate).toBe(1);
  });

  it("bands green when met, red when missed, and yellow only when a warn rule is met", () => {
    const threshold: ThresholdRule = { value: 0.9, direction: "gte" };
    const warn: ThresholdRule = { value: 0.8, direction: "gte" };
    // 0.95 ≥ 0.9 → met → green
    expect(ratioResult({ numerator: 95, denominator: 100, threshold, warn, snapshot: EMPTY_SNAPSHOT }).bandColor).toBe("green");
    // 0.85: misses threshold, meets warn → yellow
    const mid = ratioResult({ numerator: 85, denominator: 100, threshold, warn, snapshot: EMPTY_SNAPSHOT });
    expect(mid.bandColor).toBe("yellow");
    expect(mid.thresholdMet).toBe(false);
    // 0.7: misses both → red
    expect(ratioResult({ numerator: 70, denominator: 100, threshold, warn, snapshot: EMPTY_SNAPSHOT }).bandColor).toBe("red");
    // no warn rule → straight to red on a miss
    expect(ratioResult({ numerator: 85, denominator: 100, threshold, snapshot: EMPTY_SNAPSHOT }).bandColor).toBe("red");
  });

  it("evaluateThreshold respects direction (gte higher-is-better, lte lower-is-better)", () => {
    expect(evaluateThreshold(0.8, { value: 0.8, direction: "gte" })).toBe(true);
    expect(evaluateThreshold(0.79, { value: 0.8, direction: "gte" })).toBe(false);
    expect(evaluateThreshold(0.13, { value: 0.13, direction: "lte" })).toBe(true);
    expect(evaluateThreshold(0.14, { value: 0.13, direction: "lte" })).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// HCI indicators — numerator/denominator/rate + directional threshold banding
// -----------------------------------------------------------------------------

describe("HCI indicators", () => {
  const T = HCI_THRESHOLDS_v2025.indicators;

  it("indicator 01 (CHC/GIP provided, higher-is-better) bands on the gte threshold", () => {
    const met = computeHciIndicator01({ ...BASE, totalElectionPeriods: 100, periodsWithChcOrGipDay: 5, threshold: T.indicator_01 });
    expect(met.rate).toBeCloseTo(0.05);
    expect(met.thresholdMet).toBe(true); // 0.05 ≥ 0.01
    expect(met.bandColor).toBe("green");
    const missed = computeHciIndicator01({ ...BASE, totalElectionPeriods: 100, periodsWithChcOrGipDay: 0, threshold: T.indicator_01 });
    expect(missed.thresholdMet).toBe(false);
    expect(missed.bandColor).toBe("red");
    expect(missed.computationSnapshot).toMatchObject({ indicator: "hci_indicator_01", totalElectionPeriods: 100, periodsWithChcOrGipDay: 0 });
  });

  it("indicator 02 (SN-visit gaps, lower-is-better) meets at/below the lte threshold", () => {
    const met = computeHciIndicator02({ ...BASE, totalElectionPeriods: 100, periodsWithSkilledNursingGap: 13, threshold: T.indicator_02 });
    expect(met.rate).toBeCloseTo(0.13);
    expect(met.thresholdMet).toBe(true); // 0.13 ≤ 0.13
    const missed = computeHciIndicator02({ ...BASE, totalElectionPeriods: 100, periodsWithSkilledNursingGap: 20, threshold: T.indicator_02 });
    expect(missed.thresholdMet).toBe(false); // 0.20 > 0.13
    expect(missed.bandColor).toBe("red");
  });

  it("indicator 07 (spend-vs-benchmark ratio, lower-is-better) treats spend/benchmark as the rate", () => {
    const under = computeHciIndicator07({ ...BASE, totalMedicareSpend: 900, benchmarkSpend: 1000, threshold: T.indicator_07 });
    expect(under.rate).toBeCloseTo(0.9);
    expect(under.thresholdMet).toBe(true); // 0.9 ≤ 1.0
    const over = computeHciIndicator07({ ...BASE, totalMedicareSpend: 1100, benchmarkSpend: 1000, threshold: T.indicator_07 });
    expect(over.rate).toBeCloseTo(1.1);
    expect(over.thresholdMet).toBe(false);
  });

  it("indicator 10 (visits near death, higher-is-better) bands on the gte threshold", () => {
    const met = computeHciIndicator10({ ...BASE, totalDecedents: 100, decedentsWithNearDeathVisits: 90, threshold: T.indicator_10 });
    expect(met.thresholdMet).toBe(true); // 0.90 ≥ 0.80
    const missed = computeHciIndicator10({ ...BASE, totalDecedents: 100, decedentsWithNearDeathVisits: 70, threshold: T.indicator_10 });
    expect(missed.thresholdMet).toBe(false); // 0.70 < 0.80
  });

  it("an indicator with a zero denominator emits insufficient_n (no breach)", () => {
    const r = computeHciIndicator10({ ...BASE, totalDecedents: 0, decedentsWithNearDeathVisits: 0, threshold: T.indicator_10 });
    expect(r.bandColor).toBe("insufficient_n");
    expect(r.thresholdMet).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// HCI composite scoring (D15: ≥ 7/10 above national average; mid-band ≥ 5)
// -----------------------------------------------------------------------------

describe("HCI composite (computeHciScore)", () => {
  const thresholds = HCI_THRESHOLDS_v2025;

  it("scores the met-count over 10 and is green at/above the above-average cut", () => {
    const all = computeHciScore({ indicators: hciIndicators(Array(10).fill(true)), thresholds });
    expect(all.numerator).toBe(10);
    expect(all.denominator).toBe(10);
    expect(all.rate).toBe(1);
    expect(all.thresholdMet).toBe(true);
    expect(all.bandColor).toBe("green");
    const exactly7 = computeHciScore({ indicators: hciIndicators([true, true, true, true, true, true, true, false, false, false]), thresholds });
    expect(exactly7.numerator).toBe(7);
    expect(exactly7.thresholdMet).toBe(true);
    expect(exactly7.bandColor).toBe("green");
  });

  it("is yellow in the mid band (≥ 5 and < 7) and red below the mid-band floor", () => {
    const six = computeHciScore({ indicators: hciIndicators([true, true, true, true, true, true, false, false, false, false]), thresholds });
    expect(six.numerator).toBe(6);
    expect(six.thresholdMet).toBe(false);
    expect(six.bandColor).toBe("yellow");
    const four = computeHciScore({ indicators: hciIndicators([true, true, true, true, false, false, false, false, false, false]), thresholds });
    expect(four.numerator).toBe(4);
    expect(four.bandColor).toBe("red");
    expect(HCI_MID_BAND_SCORE).toBe(5);
  });

  it("an insufficient_n indicator counts as NOT-met for the composite (only thresholdMet===true scores)", () => {
    // 6 met + 1 insufficient_n (null) + 3 missed → met-count 6 → yellow, not 7/green.
    const verdicts: (boolean | null)[] = [true, true, true, true, true, true, null, false, false, false];
    const r = computeHciScore({ indicators: hciIndicators(verdicts), thresholds });
    expect(r.numerator).toBe(6);
    expect(r.bandColor).toBe("yellow");
    const snap = r.computationSnapshot as { score: number; maxScore: number; aboveAverageCut: number; perIndicatorThresholdMet: Record<string, boolean | null> };
    expect(snap.score).toBe(6);
    expect(snap.maxScore).toBe(10);
    expect(snap.aboveAverageCut).toBe(7);
    expect(snap.perIndicatorThresholdMet.indicator_07).toBeNull();
  });

  it("respects a per-FY above-average cut from the threshold table", () => {
    // a hypothetical stricter cut of 9 makes a score of 8 fall short.
    const strict = { ...thresholds, compositeAboveAverageScore: 9 };
    const r = computeHciScore({ indicators: hciIndicators([true, true, true, true, true, true, true, true, false, false]), thresholds: strict });
    expect(r.numerator).toBe(8);
    expect(r.thresholdMet).toBe(false); // 8 < 9
    expect(r.bandColor).toBe("yellow"); // still ≥ mid-band floor 5
  });
});

// -----------------------------------------------------------------------------
// HCI threshold tables (per-FY constants)
// -----------------------------------------------------------------------------

describe("HCI threshold tables", () => {
  it("FY2025 carries a directional rule for each of the ten indicators + the ≥7 composite cut", () => {
    expect(HCI_THRESHOLDS_v2025.compositeAboveAverageScore).toBe(7);
    expect(Object.keys(HCI_THRESHOLDS_v2025.indicators)).toHaveLength(10);
    expect(HCI_THRESHOLDS_v2025.indicators.indicator_01.direction).toBe("gte");
    expect(HCI_THRESHOLDS_v2025.indicators.indicator_02.direction).toBe("lte");
  });

  it("FY2026 carries the FY2025 thresholds forward (only the fiscalYear advances)", () => {
    expect(HCI_THRESHOLDS_v2026.fiscalYear).toBe(2026);
    expect(HCI_THRESHOLDS_v2026.compositeAboveAverageScore).toBe(HCI_THRESHOLDS_v2025.compositeAboveAverageScore);
    expect(HCI_THRESHOLDS_v2026.indicators).toEqual(HCI_THRESHOLDS_v2025.indicators);
  });
});

// -----------------------------------------------------------------------------
// HVLDL — §4.11 external-source snapshot enrichment + W-M30-26 Risk-Register flag
// -----------------------------------------------------------------------------

describe("HVLDL (§4.11 external-source enrichment, W-M30-26)", () => {
  type Decedent = HvldlDecedentInput;

  function run(decedents: readonly Decedent[], nationalAvg: number) {
    const result = computeHvldl({ ...BASE, nationalAvg, decedents });
    const snap = result.computationSnapshot as {
      measure: string;
      minQualifyingVisits: number;
      nationalAvg: number;
      externalSourceBreakdown: HvldlExternalSourceBreakdown;
      riskRegisterFlag: HvldlRiskRegisterFlag | null;
    };
    return { result, snap };
  }

  it("default minimum qualifying visits is the CMS ≥2 spec value", () => {
    expect(HVLDL_MIN_QUALIFYING_VISITS).toBe(2);
  });

  it("counts decedents with ≥2 qualifying visits in the numerator; all sources in the denominator", () => {
    const decedents: Decedent[] = [
      { patientId: "p1", source: "internal_clinician_recorded", qualifyingDisciplineVisitsInLastDays: 3 },
      { patientId: "p2", source: "internal_clinician_recorded", qualifyingDisciplineVisitsInLastDays: 2 },
      { patientId: "p3", source: "internal_clinician_recorded", qualifyingDisciplineVisitsInLastDays: 1 },
      { patientId: "p4", source: "hl7_external", cosignStatus: "cosigned", qualifyingDisciplineVisitsInLastDays: 2 },
    ];
    const { result } = run(decedents, 0.6);
    expect(result.numerator).toBe(3); // p1, p2, p4
    expect(result.denominator).toBe(4); // external p4 STAYS in the denominator
    expect(result.rate).toBe(0.75);
    expect(result.thresholdMet).toBe(true); // 0.75 ≥ 0.6
    expect(result.bandColor).toBe("green");
  });

  it("records the per-source breakdown and includes external deaths regardless of cosign state", () => {
    const decedents: Decedent[] = [
      { patientId: "i1", source: "internal_clinician_recorded", qualifyingDisciplineVisitsInLastDays: 2 },
      { patientId: "e1", source: "hl7_external", cosignStatus: "cosigned", qualifyingDisciplineVisitsInLastDays: 2 },
      { patientId: "e2", source: "hl7_external", cosignStatus: "pending", qualifyingDisciplineVisitsInLastDays: 0 },
    ];
    const { snap } = run(decedents, 0.6);
    const b = snap.externalSourceBreakdown;
    expect(b.totalDecedentsInPeriod).toBe(3);
    expect(b.internalClinicianRecorded).toBe(1);
    expect(b.hl7External).toBe(2);
    expect(b.hl7ExternalSubset.withCosign).toBe(1);
    expect(b.hl7ExternalSubset.pendingCosign).toBe(1);
    expect(b.hl7ExternalSubset.denominatorIncludedAnyway).toBe(2);
  });

  it("W-M30-26: fires the Risk-Register flag when below national avg AND ≥10% external-source", () => {
    // Mirrors §7.11: 100 decedents, 15 external (15% ≥ 10%), score below national average.
    const decedents: Decedent[] = [];
    for (let i = 0; i < 85; i++) decedents.push({ patientId: `i${i}`, source: "internal_clinician_recorded", qualifyingDisciplineVisitsInLastDays: i < 50 ? 2 : 0 });
    for (let i = 0; i < 15; i++) decedents.push({ patientId: `e${i}`, source: "hl7_external", cosignStatus: "cosigned", qualifyingDisciplineVisitsInLastDays: 0 });
    const { result, snap } = run(decedents, 0.85);
    expect(result.denominator).toBe(100);
    expect(result.rate).toBe(0.5); // 50/100, below 0.85
    expect(result.thresholdMet).toBe(false);
    expect(snap.riskRegisterFlag).not.toBeNull();
    expect(snap.riskRegisterFlag?.indicator).toBe("cms_attribution_under_review");
    expect(snap.riskRegisterFlag?.severity).toBe("medium");
    expect(snap.riskRegisterFlag?.rationale).toContain("15.0% external-source");
  });

  it("does NOT fire the flag when external-source is below the 10% fraction (even if below national avg)", () => {
    const decedents: Decedent[] = [];
    for (let i = 0; i < 95; i++) decedents.push({ patientId: `i${i}`, source: "internal_clinician_recorded", qualifyingDisciplineVisitsInLastDays: 0 });
    for (let i = 0; i < 5; i++) decedents.push({ patientId: `e${i}`, source: "hl7_external", cosignStatus: "cosigned", qualifyingDisciplineVisitsInLastDays: 0 });
    const { snap } = run(decedents, 0.85); // rate 0 < national avg, but 5% external < 10%
    expect(snap.riskRegisterFlag).toBeNull();
  });

  it("does NOT fire the flag when the score is at/above national average (even with ≥10% external)", () => {
    const decedents: Decedent[] = [];
    for (let i = 0; i < 80; i++) decedents.push({ patientId: `i${i}`, source: "internal_clinician_recorded", qualifyingDisciplineVisitsInLastDays: 2 });
    for (let i = 0; i < 20; i++) decedents.push({ patientId: `e${i}`, source: "hl7_external", cosignStatus: "cosigned", qualifyingDisciplineVisitsInLastDays: 2 });
    const { result, snap } = run(decedents, 0.85); // rate 1.0 ≥ national avg, 20% external
    expect(result.rate).toBe(1);
    expect(snap.riskRegisterFlag).toBeNull();
  });

  it("an empty decedent census is insufficient_n with no flag", () => {
    const { result, snap } = run([], 0.85);
    expect(result.bandColor).toBe("insufficient_n");
    expect(result.rate).toBeNull();
    expect(snap.riskRegisterFlag).toBeNull();
    expect(snap.externalSourceBreakdown.totalDecedentsInPeriod).toBe(0);
  });

  it("respects an overridden minQualifyingVisits (FY-tuning of the qualifying-visit floor)", () => {
    const decedents: Decedent[] = [
      { patientId: "p1", source: "internal_clinician_recorded", qualifyingDisciplineVisitsInLastDays: 2 },
      { patientId: "p2", source: "internal_clinician_recorded", qualifyingDisciplineVisitsInLastDays: 3 },
    ];
    const result = computeHvldl({ ...BASE, nationalAvg: 0.6, decedents, minQualifyingVisits: 3 });
    expect(result.numerator).toBe(1); // only p2 has ≥ 3
    const snap = result.computationSnapshot as { minQualifyingVisits: number };
    expect(snap.minQualifyingVisits).toBe(3);
  });

  it("the 10% flag fraction + FY discipline lists are the documented constants", () => {
    expect(HVLDL_EXTERNAL_SOURCE_FLAG_FRACTION).toBe(0.1);
    expect(HVLDL_QUALIFYING_DISCIPLINES_v2025).toEqual(["rn", "msw"]);
    expect(HVLDL_QUALIFYING_DISCIPLINES_v2028).toEqual(["rn", "msw", "chaplain", "aide"]);
  });
});

// -----------------------------------------------------------------------------
// HOPE-derived TFP measures (FY2028)
// -----------------------------------------------------------------------------

describe("HOPE-derived TFP measures", () => {
  it("TFP-PI counts in-window SFV completions over qualifying pain-impact triggers", () => {
    const r = computeTimelyFollowUpPain({
      ...BASE,
      qualifyingPainImpactTriggers: 20,
      followUpVisitsWithinWindow: 18,
      threshold: { value: 0.85, direction: "gte" },
    });
    expect(r.rate).toBeCloseTo(0.9);
    expect(r.thresholdMet).toBe(true);
    const snap = r.computationSnapshot as { measure: string; followUpWindowDays: number };
    expect(snap.measure).toBe("tfp_pi");
    expect(snap.followUpWindowDays).toBe(TFP_FOLLOW_UP_WINDOW_DAYS);
    expect(TFP_FOLLOW_UP_WINDOW_DAYS).toBe(2);
  });

  it("TFP-NPSI mirrors the structure for non-pain symptom-impact triggers", () => {
    const r = computeTimelyFollowUpNonPain({
      ...BASE,
      qualifyingNonPainImpactTriggers: 10,
      followUpVisitsWithinWindow: 5,
      threshold: { value: 0.85, direction: "gte" },
    });
    expect(r.rate).toBe(0.5);
    expect(r.thresholdMet).toBe(false);
    expect((r.computationSnapshot as { measure: string }).measure).toBe("tfp_npsi");
  });

  it("zero qualifying triggers → insufficient_n", () => {
    const r = computeTimelyFollowUpPain({ ...BASE, qualifyingPainImpactTriggers: 0, followUpVisitsWithinWindow: 0, threshold: { value: 0.85, direction: "gte" } });
    expect(r.bandColor).toBe("insufficient_n");
  });
});

// -----------------------------------------------------------------------------
// Operational measures — representative subset
// -----------------------------------------------------------------------------

describe("operational measures (representative subset)", () => {
  const gte: ThresholdRule = { value: 0.9, direction: "gte" };
  const lte: ThresholdRule = { value: 0.05, direction: "lte" };

  it("verbal-order signature on-time (higher-is-better) supports a warn band", () => {
    const yellow = computeVerbalOrderSignatureOnTime({
      ...BASE,
      totalVerbalOrders: 100,
      signedOnTime: 85,
      threshold: gte,
      warn: { value: 0.8, direction: "gte" },
    });
    expect(yellow.bandColor).toBe("yellow");
    expect((yellow.computationSnapshot as { measure: string }).measure).toBe("verbal_order_signature_on_time");
  });

  it("missed-dose rate (lower-is-better) meets at/below threshold and reds above warn", () => {
    const met = computeMissedDoseRate({ ...BASE, scheduledDoses: 100, missedDoses: 4, threshold: lte });
    expect(met.thresholdMet).toBe(true); // 0.04 ≤ 0.05
    const red = computeMissedDoseRate({ ...BASE, scheduledDoses: 100, missedDoses: 12, threshold: lte, warn: { value: 0.1, direction: "lte" } });
    expect(red.bandColor).toBe("red"); // 0.12 > 0.10
  });

  it("late-encounter-entry rate (lower-is-better) bands on the lte threshold", () => {
    const r = computeLateEncounterEntryRate({ ...BASE, signedEncounters: 200, lateEntries: 4, threshold: lte });
    expect(r.rate).toBe(0.02);
    expect(r.thresholdMet).toBe(true);
  });

  it("EVV compliance rate (higher-is-better)", () => {
    const r = computeEvvComplianceRate({ ...BASE, evvRequiredVisits: 50, evvVerifiedVisits: 49, threshold: gte });
    expect(r.rate).toBeCloseTo(0.98);
    expect(r.thresholdMet).toBe(true);
  });

  it("visit on-time rate", () => {
    const r = computeVisitOnTimeRate({ ...BASE, scheduledVisits: 80, onTimeVisits: 60, threshold: gte });
    expect(r.rate).toBe(0.75);
    expect(r.thresholdMet).toBe(false);
  });

  it("IDG cadence adherence (CoP 418.56)", () => {
    const r = computeIdgCadenceAdherence({ ...BASE, requiredMeetingCycles: 12, meetingsWithinCadence: 12, threshold: gte });
    expect(r.rate).toBe(1);
    expect(r.bandColor).toBe("green");
  });

  it("comfort-kit deployment-to-admin within-SLA rate carries SLA context on the snapshot", () => {
    const r = computeComfortKitDeploymentToAdminMinutes({
      ...BASE,
      deployments: 10,
      deploymentsAdministeredWithinSla: 9,
      slaMinutes: 60,
      medianMinutesToAdministration: 35,
      threshold: gte,
    });
    expect(r.rate).toBeCloseTo(0.9);
    const snap = r.computationSnapshot as { slaMinutes: number; medianMinutesToAdministration: number | null };
    expect(snap.slaMinutes).toBe(60);
    expect(snap.medianMinutesToAdministration).toBe(35);
  });

  it("opioid-on-admission is informational — caller supplies the direction", () => {
    // banded as lower-is-better per the caller's tracked target.
    const r = computeOpioidOnAdmissionRate({ ...BASE, admissions: 100, admissionsWithOpioid: 30, threshold: { value: 0.4, direction: "lte" } });
    expect(r.rate).toBe(0.3);
    expect(r.thresholdMet).toBe(true); // 0.3 ≤ 0.4
  });
});

// -----------------------------------------------------------------------------
// Period math (rolling-12m-to-quarter window, D14)
// -----------------------------------------------------------------------------

describe("measure-period math (periods.ts, D14)", () => {
  it("rolling-12m window ends at the start of the quarter CONTAINING asOf, 12 months earlier", () => {
    // asOf in Q2-2026 → [2025-04-01, 2026-04-01)
    const w = rolling12MonthToQuarterWindow(new Date("2026-05-15T12:00:00Z"));
    expect(w.kind).toBe("rolling_12m_to_quarter");
    expect(w.start).toBe("2025-04-01");
    expect(w.end).toBe("2026-04-01");
    expect(w.end > w.start).toBe(true); // V-3
  });

  it("prior-completed-quarter window is the calendar quarter before the one containing asOf", () => {
    const w = priorCompletedQuarterWindow(new Date("2026-05-15T12:00:00Z"));
    expect(w.kind).toBe("calendar_quarter");
    expect(w.start).toBe("2026-01-01");
    expect(w.end).toBe("2026-04-01");
  });

  it("resolvePeriodRule routes CAHPS to calendar-quarter and everything else to the rolling default", () => {
    expect(resolvePeriodRule(MEASURE_FY_BOUNDARY_v2025, "cahps_composite").anchor).toBe("prior_completed_quarter");
    expect(resolvePeriodRule(MEASURE_FY_BOUNDARY_v2025, "hvldl").anchor).toBe("rolling_12m_to_quarter");
  });
});

// -----------------------------------------------------------------------------
// Catalog + registry — FY-activation gate (listMeasureCatalog) + binding coverage
// -----------------------------------------------------------------------------

describe("measure catalog + registry FY-activation gate", () => {
  it("the catalog has 29 entries with unique codes", () => {
    expect(MEASURE_CATALOG.length).toBe(29);
    expect(new Set(MEASURE_CATALOG.map((e) => e.code)).size).toBe(29);
  });

  it("buildMeasureRegistry resolves a callable calculator for EVERY catalog entry", () => {
    const registry = buildMeasureRegistry();
    for (const entry of MEASURE_CATALOG) {
      const reg = registry.get(entry.code);
      expect(reg).toBeDefined();
      expect(typeof reg?.calculator).toBe("function");
    }
    expect(registry.size).toBe(MEASURE_CATALOG.length);
  });

  it("listMeasureCatalog(2025) activates HCI/HVLDL/operational but NOT the FY2028 HOPE-derived measures", () => {
    const fy2025 = listMeasureCatalog(2025).map((e) => e.code);
    expect(fy2025).toContain("hci_composite");
    expect(fy2025).toContain("hvldl");
    expect(fy2025).toContain("evv_compliance_rate");
    expect(fy2025).not.toContain("tfp_pi");
    expect(fy2025).not.toContain("tfp_npsi");
  });

  it("listMeasureCatalog(2028) additionally activates the HOPE-derived TFP measures", () => {
    const fy2028 = listMeasureCatalog(2028).map((e) => e.code);
    expect(fy2028).toContain("tfp_pi");
    expect(fy2028).toContain("tfp_npsi");
    expect(fy2028.length).toBe(MEASURE_CATALOG.length);
  });

  it("listMeasureCatalog(2024) activates nothing (every measure activates FY2025+)", () => {
    expect(listMeasureCatalog(2024)).toHaveLength(0);
  });
});

import {
  computeBereavementCoverageRate,
  computeBereavementRiskScreeningCompletenessRate,
  computeCarePlan15DayAdherence,
  computeEvvComplianceRate,
  computeF2fWindowOnTimeRate,
  computeF2fWindowOverrideRate,
  computeIdgCadenceAdherence,
  computeLateEncounterEntryRate,
  computeMissedDoseRate,
  computePrnEffectivenessDocumentedRate,
  computeSupervisoryVisitOnTime,
  computeVerbalOrderSignatureOnTime,
  computeVisitOnTimeRate,
  computeVolunteerComplianceGateRate,
} from "@wardenx/quality";
// apps/backend/__tests__/m30-operational-measure-input.test.ts — the counts-not-rates measure inputs.
//
// M30's operational measures could not be bound because their producer seams returned a RATE while the
// calculators need a numerator/denominator PAIR. That is not a cosmetic mismatch: `ratioResult()`
// collapses a measure to `insufficient_n` when the denominator is under the CMS reportable floor, and
// that suppression IS the public-reporting rule. A rate has already thrown the denominator away, so
// binding one would either fabricate a denominator (publishing a rate CMS requires withheld) or lose the
// suppression entirely.
//
// M17 and M18 now expose the count pair beside their rate methods — the tallies were always in their
// stores; the division at the seam boundary was the loss. These tests pin the shaping and, more
// importantly, the empty-window behaviour the two answers disagree about.
import { describe, expect, it } from "vitest";
import { resolveOperationalMeasureInput } from "../src/modules/30-quality/jobs/m30-jobs";

const REQUEST = (code: string) => ({
  registration: { code } as never,
  organizationId: "org-1",
  providerEntityId: "pe-1",
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-04-01T00:00:00.000Z",
});

const seamsWith = (
  visit: { numerator: number; denominator: number },
  evv = visit,
  lateEntry = visit,
) => ({
  visitMetrics: {
    async getOnTimeVisitCounts() {
      return visit;
    },
  },
  evvMetrics: {
    async getComplianceCounts() {
      return evv;
    },
  },
  signedEncounters: {
    async lateEntryCountsForOrg() {
      return lateEntry;
    },
  },
  orders: {
    async getVerbalTimelinessCountsForOrg() {
      return lateEntry;
    },
  },
  carePlan: {
    async fifteenDayCycleCountsForOrg() {
      return lateEntry;
    },
  },
  administrations: {
    async getMissedDoseCountsForOrg() {
      return lateEntry;
    },
    async getPrnEffectivenessCountsForOrg() {
      return lateEntry;
    },
  },
  idg: {
    async getCadenceCountsForOrg() {
      return lateEntry;
    },
  },
  bereavementCompliance: {
    async copOutreachCounts() {
      return lateEntry;
    },
    async riskScreeningCompletenessCounts() {
      return lateEntry;
    },
  },
  disciplineCompliance: {
    async supervisoryOnTimeCounts() {
      return lateEntry;
    },
    async volunteerGateComplianceCounts() {
      return lateEntry;
    },
  },
  complianceWindow: {
    async f2fWindowOnTimeCounts() {
      return lateEntry;
    },
    async f2fWindowOverrideCounts() {
      return lateEntry;
    },
  },
});

describe("M30 operational measure inputs — counts, not rates", () => {
  it("shapes M17's on-time counts into the visit_on_time_rate calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("visit_on_time_rate"),
      seamsWith({ numerator: 180, denominator: 200 }),
    );
    expect(input).toMatchObject({ scheduledVisits: 200, onTimeVisits: 180 });

    const result = computeVisitOnTimeRate(input as never);
    expect(result.numerator).toBe(180);
    expect(result.denominator).toBe(200);
    expect(result.rate).toBeCloseTo(0.9);
  });

  it("shapes M18's compliance counts into the evv_compliance_rate calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("evv_compliance_rate"),
      seamsWith({ numerator: 0, denominator: 0 }, { numerator: 96, denominator: 100 }),
    );
    expect(input).toMatchObject({ evvRequiredVisits: 100, evvVerifiedVisits: 96 });
    expect(computeEvvComplianceRate(input as never).rate).toBeCloseTo(0.96);
  });

  it("an EMPTY window SUPPRESSES rather than scoring a perfect rate (the whole point of the pair)", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("visit_on_time_rate"),
      seamsWith({ numerator: 0, denominator: 0 }),
    );
    const result = computeVisitOnTimeRate(input as never);
    // M17's RATE method answers 1 for an empty window ("vacuously on-time") — right for a dashboard tile,
    // wrong for a CMS-reportable measure. With the pair, the kernel suppresses on the denominator floor.
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });

  it("carries the real denominator through, so small-N suppression can fire on a nonzero numerator", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("evv_compliance_rate"),
      seamsWith({ numerator: 0, denominator: 0 }, { numerator: 0, denominator: 0 }),
    );
    const result = computeEvvComplianceRate(input as never);
    expect(result.bandColor).toBe("insufficient_n");
    expect(result.rate).toBeNull();
  });

  it("shapes M8's org-level late-entry tally into the late_encounter_entry_rate input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("late_encounter_entry_rate"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 7, denominator: 300 }),
    );
    expect(input).toMatchObject({ signedEncounters: 300, lateEntries: 7 });

    const result = computeLateEncounterEntryRate(input as never);
    expect(result.denominator).toBe(300);
    expect(result.rate).toBeCloseTo(7 / 300);
  });

  it("a window with no SIGNED encounters suppresses rather than scoring zero late entries", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("late_encounter_entry_rate"),
      seamsWith({ numerator: 0, denominator: 0 }),
    );
    const result = computeLateEncounterEntryRate(input as never);
    expect(result.bandColor).toBe("insufficient_n");
    expect(result.rate).toBeNull();
  });

  it("shapes M11's verbal-order timeliness tally into its calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("verbal_order_signature_on_time"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 44, denominator: 50 }),
    );
    expect(input).toMatchObject({ totalVerbalOrders: 50, signedOnTime: 44 });
    expect(computeVerbalOrderSignatureOnTime(input as never).rate).toBeCloseTo(0.88);
  });

  it("shapes M7's 15-day review-cycle tally into its calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("care_plan_15_day_adherence"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 118, denominator: 120 }),
    );
    expect(input).toMatchObject({ carePlanCyclesDue: 120, cyclesUpdatedWithin15Days: 118 });
    expect(computeCarePlan15DayAdherence(input as never).denominator).toBe(120);
  });

  it("every newly bound measure suppresses on an empty window rather than scoring perfect", async () => {
    const empty = seamsWith({ numerator: 0, denominator: 0 });
    for (const code of ["verbal_order_signature_on_time", "care_plan_15_day_adherence"] as const) {
      const input = await resolveOperationalMeasureInput(REQUEST(code), empty);
      const compute =
        code === "verbal_order_signature_on_time"
          ? computeVerbalOrderSignatureOnTime
          : computeCarePlan15DayAdherence;
      expect(compute(input as never).bandColor, code).toBe("insufficient_n");
    }
  });

  it("shapes M13's org-level missed-dose tally into its calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("missed_dose_rate"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 9, denominator: 1200 }),
    );
    expect(input).toMatchObject({ scheduledDoses: 1200, missedDoses: 9 });
    expect(computeMissedDoseRate(input as never).rate).toBeCloseTo(9 / 1200);
  });

  it("shapes M14's org-level IDG cadence tally into its calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("idg_cadence_adherence"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 38, denominator: 40 }),
    );
    expect(input).toMatchObject({ requiredMeetingCycles: 40, meetingsWithinCadence: 38 });
    expect(computeIdgCadenceAdherence(input as never).rate).toBeCloseTo(0.95);
  });

  it("a skipped cadence cycle stays in the denominator (0 held of 40 due is 0%, not suppressed)", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("idg_cadence_adherence"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 0, denominator: 40 }),
    );
    const result = computeIdgCadenceAdherence(input as never);
    // The whole point of keeping never-convened meetings in the population: a skipped cycle must show
    // as non-adherence, not vanish from the measure.
    expect(result.denominator).toBe(40);
    expect(result.rate).toBe(0);
    expect(result.bandColor).not.toBe("insufficient_n");
  });

  it("shapes M13's org-level PRN-effectiveness tally (M9-reassessment join) into its calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("prn_effectiveness_documented_rate"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 42, denominator: 50 }),
    );
    expect(input).toMatchObject({ prnAdministrations: 50, prnWithEffectivenessDocumented: 42 });
    expect(computePrnEffectivenessDocumentedRate(input as never).rate).toBeCloseTo(42 / 50);
  });

  it("PRN-effectiveness with no obligations in the window suppresses rather than scoring perfect", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("prn_effectiveness_documented_rate"),
      seamsWith({ numerator: 0, denominator: 0 }),
    );
    const result = computePrnEffectivenessDocumentedRate(input as never);
    expect(result.denominator).toBe(0);
    expect(result.bandColor).toBe("insufficient_n");
    expect(result.rate).toBeNull();
  });

  it("shapes M16's CoP 418.64(d) outreach-compliance tally into its calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("bereavement_coverage_rate"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 27, denominator: 30 }),
    );
    expect(input).toMatchObject({ eligibleBereaved: 30, bereavedWithPlan: 27 });
    expect(computeBereavementCoverageRate(input as never).rate).toBeCloseTo(0.9);
  });

  it("no eligible bereaved caregivers in the window suppresses rather than scoring perfect", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("bereavement_coverage_rate"),
      seamsWith({ numerator: 0, denominator: 0 }),
    );
    const result = computeBereavementCoverageRate(input as never);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });

  it("F-184: shapes M16's D17 screening-completeness tally into the bereavement_risk_screening_completeness_rate calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("bereavement_risk_screening_completeness_rate"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 18, denominator: 19 }),
    );
    expect(input).toMatchObject({ screeningsDue: 19, screeningsCompleted: 18 });
    expect(computeBereavementRiskScreeningCompletenessRate(input as never).rate).toBeCloseTo(
      18 / 19,
    );
  });

  it("F-184: no bereaved contacts owed a risk screen in the window suppresses rather than scoring perfect", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("bereavement_risk_screening_completeness_rate"),
      seamsWith({ numerator: 0, denominator: 0 }),
    );
    const result = computeBereavementRiskScreeningCompletenessRate(input as never);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });

  it("shapes M15's supervisory-visit timeliness tally into its calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("supervisory_visit_on_time"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 19, denominator: 20 }),
    );
    expect(input).toMatchObject({ requiredSupervisoryVisits: 20, supervisoryVisitsOnTime: 19 });
    expect(computeSupervisoryVisitOnTime(input as never).rate).toBeCloseTo(0.95);
  });

  it("no required supervisory visits in the window suppresses rather than scoring perfect", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("supervisory_visit_on_time"),
      seamsWith({ numerator: 0, denominator: 0 }),
    );
    const result = computeSupervisoryVisitOnTime(input as never);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });

  it("shapes M15's volunteer-gate compliance tally into its calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("volunteer_compliance_gate_rate"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 18, denominator: 19 }),
    );
    expect(input).toMatchObject({ evaluatedPeriods: 19, periodsMeetingGate: 18 });
    expect(computeVolunteerComplianceGateRate(input as never).rate).toBeCloseTo(18 / 19);
  });

  it("no volunteers with an open assignment in the window suppresses rather than scoring perfect", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("volunteer_compliance_gate_rate"),
      seamsWith({ numerator: 0, denominator: 0 }),
    );
    const result = computeVolunteerComplianceGateRate(input as never);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });

  it("F-178: shapes M6's F2F on-time-close tally into the f2f_window_on_time_rate calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("f2f_window_on_time_rate"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 38, denominator: 40 }),
    );
    expect(input).toMatchObject({ f2fWindowsDue: 40, f2fClosedOnTime: 38 });
    expect(computeF2fWindowOnTimeRate(input as never).rate).toBeCloseTo(0.95);
  });

  it("F-178: no F2F windows due in the window suppresses rather than scoring perfect", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("f2f_window_on_time_rate"),
      seamsWith({ numerator: 0, denominator: 0 }),
    );
    const result = computeF2fWindowOnTimeRate(input as never);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });

  it("F-178: shapes M6's F2F override-close tally into the f2f_window_override_rate calculator input", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("f2f_window_override_rate"),
      seamsWith({ numerator: 0, denominator: 0 }, undefined, { numerator: 2, denominator: 40 }),
    );
    expect(input).toMatchObject({ f2fWindowsDue: 40, f2fClosedViaOverride: 2 });
    expect(computeF2fWindowOverrideRate(input as never).rate).toBeCloseTo(0.05);
  });

  it("F-178: no F2F windows due in the window suppresses the override rate too", async () => {
    const input = await resolveOperationalMeasureInput(
      REQUEST("f2f_window_override_rate"),
      seamsWith({ numerator: 0, denominator: 0 }),
    );
    const result = computeF2fWindowOverrideRate(input as never);
    expect(result.denominator).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.bandColor).toBe("insufficient_n");
  });

  it("refuses a measure code it does not shape rather than computing on an empty input", async () => {
    // `opioid_on_admission_rate` is a real operational measure that is NOT wired here (M38 terminology gap),
    // so the resolver must refuse it rather than fabricate an input.
    await expect(
      resolveOperationalMeasureInput(
        REQUEST("opioid_on_admission_rate"),
        seamsWith({ numerator: 1, denominator: 2 }),
      ),
    ).rejects.toThrow();
  });
});

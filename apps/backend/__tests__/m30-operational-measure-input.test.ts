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
import {
  computeCarePlan15DayAdherence,
  computeEvvComplianceRate,
  computeLateEncounterEntryRate,
  computeVerbalOrderSignatureOnTime,
  computeVisitOnTimeRate,
} from "@wardenx/quality";
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
  visitMetrics: { async getOnTimeVisitCounts() { return visit; } },
  evvMetrics: { async getComplianceCounts() { return evv; } },
  signedEncounters: { async lateEntryCountsForOrg() { return lateEntry; } },
  orders: { async getVerbalTimelinessCountsForOrg() { return lateEntry; } },
  carePlan: { async fifteenDayCycleCountsForOrg() { return lateEntry; } },
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
    for (const code of [
      "verbal_order_signature_on_time",
      "care_plan_15_day_adherence",
    ] as const) {
      const input = await resolveOperationalMeasureInput(REQUEST(code), empty);
      const compute =
        code === "verbal_order_signature_on_time"
          ? computeVerbalOrderSignatureOnTime
          : computeCarePlan15DayAdherence;
      expect(compute(input as never).bandColor, code).toBe("insufficient_n");
    }
  });

  it("refuses a measure code it does not shape rather than computing on an empty input", async () => {
    await expect(
      resolveOperationalMeasureInput(
        REQUEST("missed_dose_rate"),
        seamsWith({ numerator: 1, denominator: 2 }),
      ),
    ).rejects.toThrow();
  });
});

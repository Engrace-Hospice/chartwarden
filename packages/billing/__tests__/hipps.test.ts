// @wardenx/billing — M23 HIPPS calculator (D7, spec §1.1 / §3.3 `hipps_calculation`) pure-domain tests.
//
// The calculator maps M6 level-of-care periods within a claim's from-through range to per-diem segments,
// buckets RHC days by day-of-stay from the hospice ADMISSION date (days 1-7 vs 8+), applies the wage index
// to the resolved CMS base rate, and coalesces contiguous same-(LOC, bucket) days into segments. The
// EXACT CMS per-diem rate table + the 5-position HIPPS character encoding are PUBLISHED fixtures — they are
// NOT fabricated here. Below the rate table is INJECTED with representative values and the ARITHMETIC +
// STRUCTURE are asserted exactly; any byte-exact CMS rate assertion is left TODO(CMS-fixture). Pure:
// no DB/Fastify/BullMQ; everything is injected.
import { describe, expect, it } from "vitest";
import {
  applyWageIndexFactor,
  calculateHipps,
  deriveHippsCode,
  levelOfCareToCode,
  type HippsCalculationInput,
  type HippsRateTable,
  type HippsSegmentResult,
} from "@wardenx/billing";

// TODO(CMS-fixture): replace these representative per-diems with the published FY hospice rate file.
const RATE_TABLE: HippsRateTable = {
  rhcDays1to7PerDiemCents: 20_000,
  rhcDays8PlusPerDiemCents: 16_000,
  chcPerDiemCents: 160_000,
  ircPerDiemCents: 50_000,
  gipPerDiemCents: 100_000,
};

const ADMISSION = "2026-01-01"; // day-of-stay anchor; day 1 = 2026-01-01.

function input(over: Partial<HippsCalculationInput>): HippsCalculationInput {
  return {
    claimServiceFrom: "2026-01-01",
    claimServiceTo: "2026-01-07",
    hospiceAdmissionDate: ADMISSION,
    levelOfCarePeriods: [
      { levelOfCare: "routine_home_care", from: "2026-01-01", to: "2026-12-31" },
    ],
    rateTable: RATE_TABLE,
    wageIndexCcn: "381588",
    wageIndexFiscalYear: 2026,
    wageIndexFactorDecimal: "1.0000",
    ...over,
  };
}

describe("levelOfCareToCode — full-name → 3-letter code mapping", () => {
  it("maps routine_home_care → RHC", () => expect(levelOfCareToCode("routine_home_care")).toBe("RHC"));
  it("maps continuous_home_care → CHC", () => expect(levelOfCareToCode("continuous_home_care")).toBe("CHC"));
  it("maps inpatient_respite_care → IRC", () => expect(levelOfCareToCode("inpatient_respite_care")).toBe("IRC"));
  it("maps general_inpatient_care → GIP", () => expect(levelOfCareToCode("general_inpatient_care")).toBe("GIP"));
});

describe("calculateHipps — RHC days 1-7 vs 8+ boundary (day-of-stay from admission)", () => {
  it("a 7-day claim starting on the admission date is entirely days_1_7", () => {
    const r = calculateHipps(input({ claimServiceFrom: "2026-01-01", claimServiceTo: "2026-01-07" }));
    expect(r.rhcDays1to7).toBe(7);
    expect(r.rhcDays8Plus).toBe(0);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.days).toBe(7);
    expect(r.segments[0]!.rhcDayBucket).toBe("days_1_7");
    expect(r.segments[0]!.ratePerDiemCents).toBe(20_000);
    expect(r.totalCents).toBe(140_000);
    expect(r.perDiemRateCents).toBe(20_000);
  });

  it("an 8-day claim from admission splits day 7 (days_1_7) from day 8 (days_8_plus)", () => {
    const r = calculateHipps(input({ claimServiceFrom: "2026-01-01", claimServiceTo: "2026-01-08" }));
    expect(r.rhcDays1to7).toBe(7);
    expect(r.rhcDays8Plus).toBe(1);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]!.rhcDayBucket).toBe("days_1_7");
    expect(r.segments[0]!.days).toBe(7);
    expect(r.segments[1]!.rhcDayBucket).toBe("days_8_plus");
    expect(r.segments[1]!.days).toBe(1);
    expect(r.segments[1]!.ratePerDiemCents).toBe(16_000);
    expect(r.totalCents).toBe(140_000 + 16_000);
  });

  it("the exact day-7 / day-8 boundary: a 2-day claim spanning stay-day 7→8 splits into two buckets", () => {
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-01-07", claimServiceTo: "2026-01-08" }),
    );
    expect(r.segments).toHaveLength(2);
    expect(r.rhcDays1to7).toBe(1);
    expect(r.rhcDays8Plus).toBe(1);
    expect(r.totalCents).toBe(20_000 + 16_000);
  });

  it("a mid-stay interim claim (all days past day 8) bills entirely at the days_8_plus rate", () => {
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-02-01", claimServiceTo: "2026-02-05" }),
    );
    expect(r.rhcDays1to7).toBe(0);
    expect(r.rhcDays8Plus).toBe(5);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.rhcDayBucket).toBe("days_8_plus");
    expect(r.totalCents).toBe(5 * 16_000);
  });

  it("a single-day claim on the admission date is one days_1_7 day", () => {
    const r = calculateHipps(input({ claimServiceFrom: "2026-01-01", claimServiceTo: "2026-01-01" }));
    expect(r.rhcDays1to7).toBe(1);
    expect(r.segments).toHaveLength(1);
    expect(r.totalCents).toBe(20_000);
  });
});

describe("calculateHipps — non-RHC levels of care (CHC / IRC / GIP)", () => {
  it("prices a CHC-only claim at the CHC per-diem with bucket n/a", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-03-01",
        claimServiceTo: "2026-03-03",
        levelOfCarePeriods: [
          { levelOfCare: "continuous_home_care", from: "2026-03-01", to: "2026-03-03" },
        ],
      }),
    );
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.levelOfCareCode).toBe("CHC");
    expect(r.segments[0]!.rhcDayBucket).toBe("n/a");
    expect(r.totalCents).toBe(3 * 160_000);
    expect(r.rhcDays1to7).toBe(0);
    expect(r.rhcDays8Plus).toBe(0);
  });

  it("prices an IRC-only claim at the IRC per-diem", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-03-01",
        claimServiceTo: "2026-03-02",
        levelOfCarePeriods: [
          { levelOfCare: "inpatient_respite_care", from: "2026-03-01", to: "2026-03-02" },
        ],
      }),
    );
    expect(r.segments[0]!.levelOfCareCode).toBe("IRC");
    expect(r.totalCents).toBe(2 * 50_000);
  });

  it("prices a GIP-only claim at the GIP per-diem", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-03-01",
        claimServiceTo: "2026-03-04",
        levelOfCarePeriods: [
          { levelOfCare: "general_inpatient_care", from: "2026-03-01", to: "2026-03-04" },
        ],
      }),
    );
    expect(r.segments[0]!.levelOfCareCode).toBe("GIP");
    expect(r.totalCents).toBe(4 * 100_000);
  });
});

describe("calculateHipps — LOC-period mid-claim transitions + segment coalescing", () => {
  it("coalesces contiguous same-(LOC, bucket) days into a single segment", () => {
    const r = calculateHipps(input({ claimServiceFrom: "2026-02-01", claimServiceTo: "2026-02-04" }));
    // All four days are RHC days_8_plus ⇒ one coalesced 4-day segment.
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.days).toBe(4);
  });

  it("breaks a segment when the LOC changes mid-claim (RHC → GIP → RHC)", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-02-10",
        claimServiceTo: "2026-02-14",
        levelOfCarePeriods: [
          { levelOfCare: "routine_home_care", from: "2026-02-10", to: "2026-02-11" },
          { levelOfCare: "general_inpatient_care", from: "2026-02-12", to: "2026-02-13" },
          { levelOfCare: "routine_home_care", from: "2026-02-14", to: "2026-02-14" },
        ],
      }),
    );
    expect(r.segments).toHaveLength(3);
    expect(r.segments.map((s) => s.levelOfCareCode)).toEqual(["RHC", "GIP", "RHC"]);
    expect(r.segments.map((s) => s.days)).toEqual([2, 2, 1]);
    // RHC days are all past day 8 ⇒ days_8_plus.
    expect(r.totalCents).toBe(2 * 16_000 + 2 * 100_000 + 1 * 16_000);
  });

  it("breaks a segment at the RHC bucket boundary even though the LOC is unchanged", () => {
    // 2026-01-05..2026-01-09 is RHC throughout: days 5,6,7 are days_1_7; days 8,9 are days_8_plus.
    const r = calculateHipps(input({ claimServiceFrom: "2026-01-05", claimServiceTo: "2026-01-09" }));
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]!.rhcDayBucket).toBe("days_1_7");
    expect(r.segments[0]!.days).toBe(3);
    expect(r.segments[1]!.rhcDayBucket).toBe("days_8_plus");
    expect(r.segments[1]!.days).toBe(2);
  });

  it("assigns 1-based hipps char positions in segment order", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-02-10",
        claimServiceTo: "2026-02-12",
        levelOfCarePeriods: [
          { levelOfCare: "routine_home_care", from: "2026-02-10", to: "2026-02-10" },
          { levelOfCare: "general_inpatient_care", from: "2026-02-11", to: "2026-02-11" },
          { levelOfCare: "inpatient_respite_care", from: "2026-02-12", to: "2026-02-12" },
        ],
      }),
    );
    expect(r.segments.map((s) => s.hippsCharPosition)).toEqual([1, 2, 3]);
  });

  it("each segment's total is rate × days", () => {
    const r = calculateHipps(input({ claimServiceFrom: "2026-02-01", claimServiceTo: "2026-02-03" }));
    for (const seg of r.segments) {
      expect(seg.segmentTotalCents).toBe(seg.ratePerDiemCents * seg.days);
    }
  });
});

describe("calculateHipps — gap days (uncovered by any LOC period)", () => {
  it("skips a day not covered by any LOC period (no charge, no segment day)", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-02-01",
        claimServiceTo: "2026-02-05",
        levelOfCarePeriods: [
          { levelOfCare: "routine_home_care", from: "2026-02-01", to: "2026-02-02" },
          { levelOfCare: "routine_home_care", from: "2026-02-04", to: "2026-02-05" },
        ],
      }),
    );
    // 2026-02-03 is a gap day ⇒ it is NOT billed: only 4 days carry a per-diem, all RHC days_8_plus.
    expect(r.rhcDays8Plus).toBe(4);
    expect(r.totalCents).toBe(4 * 16_000);
    // The coalescer merges by (LOC, bucket) on consecutively-RESOLVED days, not strict calendar adjacency,
    // so the two covered runs collapse into ONE 4-day segment. The gap day carries no per-diem, so the
    // CHARGE stays correct (rate × 4) even though the segment's date span brackets the skipped day.
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.days).toBe(4);
    expect(r.segments[0]!.segmentTotalCents).toBe(4 * 16_000);
  });

  it("a claim with no covering LOC period at all yields no segments and zero totals", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-02-01",
        claimServiceTo: "2026-02-05",
        levelOfCarePeriods: [],
      }),
    );
    expect(r.segments).toHaveLength(0);
    expect(r.totalCents).toBe(0);
    expect(r.perDiemRateCents).toBe(0);
    expect(r.hippsCode).toBe("00000");
  });
});

describe("calculateHipps — wage index application + snapshot (D7 / D12)", () => {
  it("applies the wage index factor to the base rate per diem (identity at 1.0000)", () => {
    const r = calculateHipps(input({ wageIndexFactorDecimal: "1.0000" }));
    expect(r.segments[0]!.baseRatePerDiemCents).toBe(20_000);
    expect(r.segments[0]!.ratePerDiemCents).toBe(20_000);
  });

  it("scales the per-diem by a sub-1 wage index, matching the money primitive exactly", () => {
    const factor = "0.9234";
    const r = calculateHipps(input({ wageIndexFactorDecimal: factor }));
    const expectedRate = applyWageIndexFactor(20_000, factor);
    expect(r.segments[0]!.ratePerDiemCents).toBe(expectedRate);
    expect(r.segments[0]!.baseRatePerDiemCents).toBe(20_000); // base is pre-wage-index
    expect(r.totalCents).toBe(expectedRate * 7);
  });

  it("scales the per-diem by an above-1 wage index", () => {
    const factor = "1.1500";
    const r = calculateHipps(input({ wageIndexFactorDecimal: factor }));
    expect(r.segments[0]!.ratePerDiemCents).toBe(applyWageIndexFactor(20_000, factor));
  });

  it("snapshots the wage index ccn / fiscal year / factor into the result", () => {
    const r = calculateHipps(
      input({ wageIndexCcn: "777777", wageIndexFiscalYear: 2027, wageIndexFactorDecimal: "0.8765" }),
    );
    expect(r.wageIndexCcn).toBe("777777");
    expect(r.wageIndexFiscalYear).toBe(2027);
    expect(r.wageIndexFactorApplied).toBe("0.8765");
  });
});

describe("calculateHipps — invariants + invalid input", () => {
  it("the claim total equals the sum of every segment total", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-01-05",
        claimServiceTo: "2026-01-12",
        wageIndexFactorDecimal: "0.9500",
      }),
    );
    const sum = r.segments.reduce((acc, s) => acc + s.segmentTotalCents, 0);
    expect(r.totalCents).toBe(sum);
  });

  it("throws RangeError on an inverted claim range (service-to before service-from)", () => {
    expect(() =>
      calculateHipps(input({ claimServiceFrom: "2026-02-05", claimServiceTo: "2026-02-01" })),
    ).toThrow(RangeError);
  });
});

describe("deriveHippsCode — placeholder encoding (TODO(CMS-fixture))", () => {
  function seg(over: Partial<HippsSegmentResult>): HippsSegmentResult {
    return {
      levelOfCare: "routine_home_care",
      levelOfCareCode: "RHC",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-01",
      days: 1,
      baseRatePerDiemCents: 20_000,
      ratePerDiemCents: 20_000,
      rhcDayBucket: "days_1_7",
      hippsCharPosition: 1,
      segmentTotalCents: 20_000,
      ...over,
    };
  }

  it("returns the all-filler placeholder for an empty segment list", () => {
    expect(deriveHippsCode([])).toBe("00000");
  });

  it("encodes RHC days_1_7 as R1000", () => {
    expect(deriveHippsCode([seg({ rhcDayBucket: "days_1_7" })])).toBe("R1000");
  });

  it("encodes RHC days_8_plus as R8000", () => {
    expect(deriveHippsCode([seg({ rhcDayBucket: "days_8_plus" })])).toBe("R8000");
  });

  it("encodes a CHC first segment as C0000 (bucket n/a → 0)", () => {
    expect(
      deriveHippsCode([
        seg({ levelOfCare: "continuous_home_care", levelOfCareCode: "CHC", rhcDayBucket: "n/a" }),
      ]),
    ).toBe("C0000");
  });

  it("encodes an IRC first segment as I0000", () => {
    expect(
      deriveHippsCode([
        seg({ levelOfCare: "inpatient_respite_care", levelOfCareCode: "IRC", rhcDayBucket: "n/a" }),
      ]),
    ).toBe("I0000");
  });

  it("encodes a GIP first segment as G0000", () => {
    expect(
      deriveHippsCode([
        seg({ levelOfCare: "general_inpatient_care", levelOfCareCode: "GIP", rhcDayBucket: "n/a" }),
      ]),
    ).toBe("G0000");
  });

  it("derives the code from the FIRST segment only", () => {
    const code = deriveHippsCode([
      seg({ levelOfCare: "general_inpatient_care", levelOfCareCode: "GIP", rhcDayBucket: "n/a" }),
      seg({ rhcDayBucket: "days_1_7" }),
    ]);
    expect(code).toBe("G0000");
  });
});

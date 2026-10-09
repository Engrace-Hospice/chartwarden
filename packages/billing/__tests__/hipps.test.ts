import {
  ChcHoursError,
  type HippsCalculationInput,
  type HippsRateTable,
  type HippsSegmentResult,
  applyWageIndexFactor,
  applyWageIndexToLaborShare,
  calculateHipps,
  derivePerDiemClassCode,
  levelOfCareToCode,
} from "@wardenx/billing";
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

// TODO(CMS-fixture): replace these representative per-diems with the published FY hospice rate file.
const RATE_TABLE: HippsRateTable = {
  rhcDays1to60PerDiemCents: 20_000,
  rhcDays61PlusPerDiemCents: 16_000,
  chcHourlyRateCents: 6_667, // ~ $160,000-cents / 24h; CHC is priced HOURLY x documented hours (F-211)
  ircPerDiemCents: 50_000,
  gipPerDiemCents: 100_000,
  // F-211 labor shares (representative; the real ones are the CMS-published per-LOC shares, tenant-entered).
  rhcLaborShare: "0.6600",
  chcLaborShare: "0.6800",
  ircLaborShare: "0.5400",
  gipLaborShare: "0.6400",
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
  it("maps routine_home_care → RHC", () =>
    expect(levelOfCareToCode("routine_home_care")).toBe("RHC"));
  it("maps continuous_home_care → CHC", () =>
    expect(levelOfCareToCode("continuous_home_care")).toBe("CHC"));
  it("maps inpatient_respite_care → IRC", () =>
    expect(levelOfCareToCode("inpatient_respite_care")).toBe("IRC"));
  it("maps general_inpatient_care → GIP", () =>
    expect(levelOfCareToCode("general_inpatient_care")).toBe("GIP"));
});

describe("calculateHipps — ADR-0001 RHC day-60 tier boundary (day-of-stay from admission)", () => {
  // ADMISSION = 2026-01-01 ⇒ day 60 = 2026-03-01, day 61 = 2026-03-02.
  it("a 7-day claim starting on the admission date is entirely RHC-High (days_1_60)", () => {
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-01-01", claimServiceTo: "2026-01-07" }),
    );
    expect(r.rhcDays1to60).toBe(7);
    expect(r.rhcDays61Plus).toBe(0);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.days).toBe(7);
    expect(r.segments[0]!.rhcDayBucket).toBe("days_1_60");
    expect(r.segments[0]!.ratePerDiemCents).toBe(20_000);
    expect(r.totalCents).toBe(140_000);
    expect(r.perDiemRateCents).toBe(20_000);
  });

  it("day 8 is STILL RHC-High — the old day-7 boundary was the ADR-0001 defect", () => {
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-01-01", claimServiceTo: "2026-01-08" }),
    );
    expect(r.rhcDays1to60).toBe(8);
    expect(r.rhcDays61Plus).toBe(0);
    expect(r.segments).toHaveLength(1);
    expect(r.totalCents).toBe(8 * 20_000);
  });

  it("the exact day-60 / day-61 boundary: a 2-day claim spanning stay-day 60→61 splits into two tiers", () => {
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-03-01", claimServiceTo: "2026-03-02" }),
    );
    expect(r.segments).toHaveLength(2);
    expect(r.rhcDays1to60).toBe(1);
    expect(r.rhcDays61Plus).toBe(1);
    expect(r.segments[0]!.rhcDayBucket).toBe("days_1_60");
    expect(r.segments[1]!.rhcDayBucket).toBe("days_61_plus");
    expect(r.segments[1]!.ratePerDiemCents).toBe(16_000);
    expect(r.totalCents).toBe(20_000 + 16_000);
  });

  it("a mid-stay interim claim past day 60 bills entirely at the RHC-Low (days_61_plus) rate", () => {
    // 2026-04-01 is stay-day 91.
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-04-01", claimServiceTo: "2026-04-05" }),
    );
    expect(r.rhcDays1to60).toBe(0);
    expect(r.rhcDays61Plus).toBe(5);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.rhcDayBucket).toBe("days_61_plus");
    expect(r.totalCents).toBe(5 * 16_000);
  });

  it("a single-day claim on the admission date is one days_1_60 day", () => {
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-01-01", claimServiceTo: "2026-01-01" }),
    );
    expect(r.rhcDays1to60).toBe(1);
    expect(r.segments).toHaveLength(1);
    expect(r.totalCents).toBe(20_000);
  });
});

describe("calculateHipps — non-RHC levels of care (CHC / IRC / GIP)", () => {
  it("prices a CHC-only claim HOURLY (rate x documented hours) with bucket n/a, one segment per day", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-03-01",
        claimServiceTo: "2026-03-03",
        levelOfCarePeriods: [
          {
            levelOfCare: "continuous_home_care",
            from: "2026-03-01",
            to: "2026-03-03",
            chcDocumentedHours: 24,
          },
        ],
      }),
    );
    // CHC never coalesces: each day's charge depends on that day's hours.
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]!.levelOfCareCode).toBe("CHC");
    expect(r.segments[0]!.rhcDayBucket).toBe("n/a");
    expect(r.segments[0]!.days).toBe(1);
    expect(r.segments[0]!.chcHours).toBe(24);
    expect(r.segments[0]!.chcAdjustedHourlyRateCents).toBe(6_667); // WI 1.0000
    // 24 h x 6667 = 160,008 per day (NOT a per-diem multiple of 160,000).
    expect(r.segments[0]!.ratePerDiemCents).toBe(160_008);
    expect(r.totalCents).toBe(3 * 160_008);
    expect(r.rhcDays1to60).toBe(0);
    expect(r.rhcDays61Plus).toBe(0);
  });

  it("CHC day = the labor-share-adjusted HOURLY rate x hours (hand-computed, WI 0.9000, labor 0.68)", () => {
    // adjusted hourly = 6667 x (0.68 x 0.9 + 0.32) = 6667 x 0.932 = 6213.644 -> 6214 (half-up).
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-03-01",
        claimServiceTo: "2026-03-01",
        wageIndexFactorDecimal: "0.9000",
        levelOfCarePeriods: [
          {
            levelOfCare: "continuous_home_care",
            from: "2026-03-01",
            to: "2026-03-01",
            chcDocumentedHours: 10,
          },
        ],
      }),
    );
    expect(r.segments[0]!.chcAdjustedHourlyRateCents).toBe(6_214);
    expect(r.segments[0]!.ratePerDiemCents).toBe(62_140); // 10 h x 6214
    expect(r.segments[0]!.baseRatePerDiemCents).toBe(66_670); // 10 h x 6667, pre-wage-index
    expect(r.totalCents).toBe(62_140);
  });

  it("CHC quarter-hour hours round half-up on the day's charge (8.25 h x 6214 = 51,265.5 -> 51,266)", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-03-01",
        claimServiceTo: "2026-03-01",
        wageIndexFactorDecimal: "0.9000",
        levelOfCarePeriods: [
          {
            levelOfCare: "continuous_home_care",
            from: "2026-03-01",
            to: "2026-03-01",
            chcDocumentedHours: 8.25,
          },
        ],
      }),
    );
    expect(r.totalCents).toBe(51_266);
  });

  it("accepts exactly the 8-hour CMS minimum and exactly 24 hours", () => {
    const at = (hours: number) =>
      calculateHipps(
        input({
          claimServiceFrom: "2026-03-01",
          claimServiceTo: "2026-03-01",
          levelOfCarePeriods: [
            {
              levelOfCare: "continuous_home_care",
              from: "2026-03-01",
              to: "2026-03-01",
              chcDocumentedHours: hours,
            },
          ],
        }),
      ).totalCents;
    expect(at(8)).toBe(8 * 6_667);
    expect(at(24)).toBe(24 * 6_667);
  });

  it("fails closed (ChcHoursError) on an undocumented, sub-8h, >24h or non-quarter-hour CHC day", () => {
    const run = (hours: number | null | undefined) =>
      calculateHipps(
        input({
          claimServiceFrom: "2026-03-01",
          claimServiceTo: "2026-03-01",
          levelOfCarePeriods: [
            {
              levelOfCare: "continuous_home_care",
              from: "2026-03-01",
              to: "2026-03-01",
              chcDocumentedHours: hours,
            },
          ],
        }),
      );
    expect(() => run(null)).toThrow(ChcHoursError);
    expect(() => run(undefined)).toThrow(ChcHoursError);
    expect(() => run(7.75)).toThrow(/below the 8-hour/);
    expect(() => run(24.25)).toThrow(/above the 24-hour/);
    expect(() => run(9.1)).toThrow(/15-minute units/);
    try {
      run(null);
    } catch (e) {
      expect((e as ChcHoursError).reason).toBe("undocumented");
      expect((e as ChcHoursError).dates).toEqual(["2026-03-01"]);
    }
  });

  it("a mixed RHC / CHC / RHC claim keeps RHC coalesced and splits CHC per day", () => {
    const r = calculateHipps(
      input({
        claimServiceFrom: "2026-02-10",
        claimServiceTo: "2026-02-14",
        levelOfCarePeriods: [
          { levelOfCare: "routine_home_care", from: "2026-02-10", to: "2026-02-10" },
          {
            levelOfCare: "continuous_home_care",
            from: "2026-02-11",
            to: "2026-02-12",
            chcDocumentedHours: 12,
          },
          { levelOfCare: "routine_home_care", from: "2026-02-13", to: "2026-02-14" },
        ],
      }),
    );
    expect(r.segments.map((s) => `${s.levelOfCareCode}:${s.days}`)).toEqual([
      "RHC:1",
      "CHC:1",
      "CHC:1",
      "RHC:2",
    ]);
    expect(r.totalCents).toBe(20_000 + 2 * 12 * 6_667 + 2 * 20_000);
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
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-02-01", claimServiceTo: "2026-02-04" }),
    );
    // All four days are RHC days_61_plus ⇒ one coalesced 4-day segment.
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
    // RHC days 41-45 of the stay ⇒ all within the day-60 RHC-High tier.
    expect(r.totalCents).toBe(2 * 20_000 + 2 * 100_000 + 1 * 20_000);
  });

  it("breaks a segment at the RHC bucket boundary even though the LOC is unchanged", () => {
    // 2026-02-27..2026-03-03 is RHC throughout: stay-days 58,59,60 are days_1_60; 61,62 are days_61_plus.
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-02-27", claimServiceTo: "2026-03-03" }),
    );
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]!.rhcDayBucket).toBe("days_1_60");
    expect(r.segments[0]!.days).toBe(3);
    expect(r.segments[1]!.rhcDayBucket).toBe("days_61_plus");
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
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-02-01", claimServiceTo: "2026-02-03" }),
    );
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
    // 2026-02-03 is a gap day ⇒ it is NOT billed: only 4 days carry a per-diem, all RHC-High (days 32-36).
    expect(r.rhcDays1to60).toBe(4);
    expect(r.totalCents).toBe(4 * 20_000);
    // The coalescer merges by (LOC, bucket) on consecutively-RESOLVED days, not strict calendar adjacency,
    // so the two covered runs collapse into ONE 4-day segment. The gap day carries no per-diem, so the
    // CHARGE stays correct (rate × 4) even though the segment's date span brackets the skipped day.
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.days).toBe(4);
    expect(r.segments[0]!.segmentTotalCents).toBe(4 * 20_000);
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
    expect(r.perDiemClassCode).toBe("00000");
  });
});

describe("calculateHipps — wage index application + snapshot (D7 / D12)", () => {
  it("applies the wage index factor to the base rate per diem (identity at 1.0000)", () => {
    const r = calculateHipps(input({ wageIndexFactorDecimal: "1.0000" }));
    expect(r.segments[0]!.baseRatePerDiemCents).toBe(20_000);
    expect(r.segments[0]!.ratePerDiemCents).toBe(20_000);
  });

  it("adjusts ONLY the labor share (F-211): RHC 20,000 x (0.66 x 0.9234 + 0.34) = 18,988.88 -> 18,989", () => {
    // Hand-computed: 0.66 x 0.9234 = 0.609444; + 0.34 = 0.949444; x 20,000 = 18,988.88.
    const r = calculateHipps(input({ wageIndexFactorDecimal: "0.9234" }));
    expect(r.segments[0]!.ratePerDiemCents).toBe(18_989);
    expect(r.segments[0]!.baseRatePerDiemCents).toBe(20_000); // base is pre-wage-index
    expect(r.totalCents).toBe(7 * 18_989);
    // The pre-fix whole-rate multiply would have been 20,000 x 0.9234 = 18,468 - a $5.21/day underpayment.
    expect(r.segments[0]!.ratePerDiemCents).not.toBe(applyWageIndexFactor(20_000, "0.9234"));
    expect(applyWageIndexFactor(20_000, "0.9234")).toBe(18_468);
  });

  it("adjusts only the labor share for an above-1 wage index: RHC 20,000 x (0.66 x 1.15 + 0.34) = 21,980", () => {
    const r = calculateHipps(input({ wageIndexFactorDecimal: "1.1500" }));
    expect(r.segments[0]!.ratePerDiemCents).toBe(21_980);
  });

  it("uses each level of care's OWN labor share (IRC 0.54, GIP 0.64), hand-computed", () => {
    // IRC 50,000 x (0.54 x 1.10 + 0.46) = 50,000 x 1.054 = 52,700.
    const irc = calculateHipps(
      input({
        claimServiceFrom: "2026-03-01",
        claimServiceTo: "2026-03-01",
        wageIndexFactorDecimal: "1.1000",
        levelOfCarePeriods: [
          { levelOfCare: "inpatient_respite_care", from: "2026-03-01", to: "2026-03-01" },
        ],
      }),
    );
    expect(irc.totalCents).toBe(52_700);
    // GIP 100,000 x (0.64 x 0.90 + 0.36) = 100,000 x 0.936 = 93,600.
    const gip = calculateHipps(
      input({
        claimServiceFrom: "2026-03-01",
        claimServiceTo: "2026-03-01",
        wageIndexFactorDecimal: "0.9000",
        levelOfCarePeriods: [
          { levelOfCare: "general_inpatient_care", from: "2026-03-01", to: "2026-03-01" },
        ],
      }),
    );
    expect(gip.totalCents).toBe(93_600);
  });

  it("a labor share of 1 reduces to the whole-rate multiply, and 0 ignores the wage index entirely", () => {
    expect(applyWageIndexToLaborShare(20_000, "0.9234", "1")).toBe(
      applyWageIndexFactor(20_000, "0.9234"),
    );
    expect(applyWageIndexToLaborShare(20_000, "0.9234", "0")).toBe(20_000);
    expect(() => applyWageIndexToLaborShare(20_000, "0.9234", "1.2")).toThrow(RangeError);
    expect(() => applyWageIndexToLaborShare(20_000, "-1", "0.6")).toThrow(RangeError);
  });

  it("snapshots the wage index ccn / fiscal year / factor into the result", () => {
    const r = calculateHipps(
      input({
        wageIndexCcn: "777777",
        wageIndexFiscalYear: 2027,
        wageIndexFactorDecimal: "0.8765",
      }),
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

describe("derivePerDiemClassCode — internal placeholder encoding (not a Medicare HIPPS code)", () => {
  function seg(over: Partial<HippsSegmentResult>): HippsSegmentResult {
    return {
      levelOfCare: "routine_home_care",
      levelOfCareCode: "RHC",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-01",
      days: 1,
      baseRatePerDiemCents: 20_000,
      ratePerDiemCents: 20_000,
      rhcDayBucket: "days_1_60",
      wageIndexFactorApplied: "1.0000",
      chcHours: null,
      chcAdjustedHourlyRateCents: null,
      hippsCharPosition: 1,
      segmentTotalCents: 20_000,
      ...over,
    };
  }

  it("returns the all-filler placeholder for an empty segment list", () => {
    expect(derivePerDiemClassCode([])).toBe("00000");
  });

  it("encodes RHC days_1_60 as R1000", () => {
    expect(derivePerDiemClassCode([seg({ rhcDayBucket: "days_1_60" })])).toBe("R1000");
  });

  it("encodes RHC days_61_plus as R6000", () => {
    expect(derivePerDiemClassCode([seg({ rhcDayBucket: "days_61_plus" })])).toBe("R6000");
  });

  it("encodes a CHC first segment as C0000 (bucket n/a → 0)", () => {
    expect(
      derivePerDiemClassCode([
        seg({ levelOfCare: "continuous_home_care", levelOfCareCode: "CHC", rhcDayBucket: "n/a" }),
      ]),
    ).toBe("C0000");
  });

  it("encodes an IRC first segment as I0000", () => {
    expect(
      derivePerDiemClassCode([
        seg({ levelOfCare: "inpatient_respite_care", levelOfCareCode: "IRC", rhcDayBucket: "n/a" }),
      ]),
    ).toBe("I0000");
  });

  it("encodes a GIP first segment as G0000", () => {
    expect(
      derivePerDiemClassCode([
        seg({ levelOfCare: "general_inpatient_care", levelOfCareCode: "GIP", rhcDayBucket: "n/a" }),
      ]),
    ).toBe("G0000");
  });

  it("derives the code from the FIRST segment only", () => {
    const code = derivePerDiemClassCode([
      seg({ levelOfCare: "general_inpatient_care", levelOfCareCode: "GIP", rhcDayBucket: "n/a" }),
      seg({ rhcDayBucket: "days_1_60" }),
    ]);
    expect(code).toBe("G0000");
  });
});

describe("calculateHipps — two-tier RHC carry-over across a readmission (Claims Processing Manual ch. 11)", () => {
  it("a readmission carrying 55 prior hospice days reaches the low rate on its 6th day", () => {
    // Arrange: readmitted 2026-01-01 within 60 days of a 55-day stay → this stay's day 1 is cumulative day 56.
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-01-01", claimServiceTo: "2026-01-10", priorHospiceDays: 55 }),
    );
    // Assert: cumulative days 56–60 high, 61–65 low.
    expect(r.rhcDays1to60).toBe(5);
    expect(r.rhcDays61Plus).toBe(5);
  });

  it("no carried days (a first stay, or a gap over 60 days) keeps the stay's own count", () => {
    const withZero = calculateHipps(
      input({ claimServiceFrom: "2026-01-01", claimServiceTo: "2026-01-10", priorHospiceDays: 0 }),
    );
    const absent = calculateHipps(
      input({ claimServiceFrom: "2026-01-01", claimServiceTo: "2026-01-10" }),
    );
    expect(withZero.rhcDays1to60).toBe(10);
    expect(absent).toEqual(withZero);
  });

  it("60 or more carried days bill the whole readmission at the low rate", () => {
    const r = calculateHipps(
      input({ claimServiceFrom: "2026-01-01", claimServiceTo: "2026-01-03", priorHospiceDays: 60 }),
    );
    expect(r.rhcDays1to60).toBe(0);
    expect(r.rhcDays61Plus).toBe(3);
  });
});

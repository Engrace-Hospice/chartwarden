// Slice 2 pricing — the pure math of the contracted census-banded model.
//   platform fee = GREATER of (staff x per-user price) and the flat fee of the census band the ADC falls in
//   billing fee  = net collections x the plan's rate for the subscription's billing service mode (0 outside ChartWarden)
// Money is integer cents, rates are basis points, ADC is hundredths of a patient (so 16.99 never meets float rounding).
import { describe, expect, it } from "vitest";
import {
  type CensusBand,
  DEFAULT_CENSUS_BAND_THRESHOLDS,
  type PlanPricing,
  averageDailyCensusHundredths,
  billingFeeCents,
  computeStatementAmounts,
  lateCollectionsCents,
  prorateCents,
  selectCensusBand,
  validatePlanPricing,
} from "../src/pricing";

// Demo prices only: the platform never hardcodes them, a plan carries them.
const BANDS: readonly CensusBand[] = [
  { minAdc: 0, monthlyFeeCents: 100_000 },
  { minAdc: 10, monthlyFeeCents: 200_000 },
  { minAdc: 17, monthlyFeeCents: 300_000 },
  { minAdc: 26, monthlyFeeCents: 400_000 },
  { minAdc: 30, monthlyFeeCents: 500_000 },
];
const PLAN: PlanPricing = {
  perUserPriceCents: 10_000,
  bands: BANDS,
  billingSoftwareBps: 100,
  managedBillingBps: 400,
  minimumMonthlyCents: null,
};
const adc = (patients: number) => Math.round(patients * 100);
const price = (over: Partial<Parameters<typeof computeStatementAmounts>[1]> = {}) =>
  computeStatementAmounts(PLAN, {
    staffCount: 0,
    adcHundredths: 0,
    netCollectionsCents: 0,
    mode: "none",
    oneTimeFeeCents: 0,
    ...over,
  });

describe("DEFAULT_CENSUS_BAND_THRESHOLDS", () => {
  it("are the owner's FIVE bands: 0-9, 10-16, 17-25, 26-29 and 30+ ADC (a starting point for a form, editable data)", () => {
    expect(DEFAULT_CENSUS_BAND_THRESHOLDS).toEqual([0, 10, 17, 26, 30]);
  });

  it("leave no gap: every whole census from 0 to 40 lands in exactly the band the owner named", () => {
    const owner = (n: number) => (n < 10 ? 0 : n < 17 ? 10 : n < 26 ? 17 : n < 30 ? 26 : 30);
    for (let n = 0; n <= 40; n++) {
      expect(selectCensusBand(BANDS, adc(n)).minAdc, `ADC ${n}`).toBe(owner(n));
    }
  });
});

describe("selectCensusBand", () => {
  const cases: ReadonlyArray<[string, number, number]> = [
    ["zero ADC", 0, 0],
    ["9 stays in the first band", 9, 0],
    ["9.99 is still below 10", 9.99, 0],
    ["10 starts the second band", 10, 10],
    ["16 stays in the second band", 16, 10],
    ["16.99 is still below 17", 16.99, 10],
    ["17 starts the third band", 17, 17],
    ["25 stays in the third band", 25, 17],
    ["25.99 is still below 26", 25.99, 17],
    ["26 starts the fourth band", 26, 26],
    ["29 stays in the fourth band", 29, 26],
    ["29.99 is still below 30", 29.99, 26],
    ["30 starts the last band", 30, 30],
    ["a very large census stays in the last band", 5_000, 30],
  ];
  for (const [name, patients, expectedMin] of cases) {
    it(name, () => {
      expect(selectCensusBand(BANDS, adc(patients)).minAdc).toBe(expectedMin);
    });
  }

  it("does not depend on the order the bands were supplied in", () => {
    expect(selectCensusBand([...BANDS].reverse(), adc(17)).minAdc).toBe(17);
  });

  it("refuses a plan without a band that starts at 0 (a zero census would have no price)", () => {
    expect(() => selectCensusBand([{ minAdc: 5, monthlyFeeCents: 1 }], 0)).toThrow(/band/i);
  });
});

describe("computeStatementAmounts: the greater-of rule", () => {
  it("charges the census band when it beats staff x per-user (3 staff = $300 vs the $1,000 band)", () => {
    const r = price({ staffCount: 3, adcHundredths: adc(5) });
    expect(r).toMatchObject({
      perUserSubtotalCents: 30_000,
      bandFeeCents: 100_000,
      platformFeeCents: 100_000,
      platformFeeBasis: "census_band",
    });
  });

  it("charges staff x per-user when it beats the band (30 staff = $3,000 vs the $1,000 band)", () => {
    const r = price({ staffCount: 30, adcHundredths: adc(5) });
    expect(r).toMatchObject({
      perUserSubtotalCents: 300_000,
      bandFeeCents: 100_000,
      platformFeeCents: 300_000,
      platformFeeBasis: "per_user",
    });
  });

  it("shows BOTH sides of the comparison on every result", () => {
    const r = price({ staffCount: 12, adcHundredths: adc(12) });
    expect(r.perUserSubtotalCents).toBe(120_000);
    expect(r.bandFeeCents).toBe(200_000);
    expect(r.bandMinAdc).toBe(10);
  });

  it("on an exact tie reports the flat band as the basis, deterministically", () => {
    const r = price({ staffCount: 10, adcHundredths: adc(0) });
    expect(r.perUserSubtotalCents).toBe(100_000);
    expect(r.platformFeeCents).toBe(100_000);
    expect(r.platformFeeBasis).toBe("census_band");
  });

  it("zero staff falls back to the band fee", () => {
    expect(price({ staffCount: 0, adcHundredths: adc(20) }).platformFeeCents).toBe(300_000);
  });

  it("zero ADC uses the lowest band", () => {
    expect(price({ staffCount: 1, adcHundredths: 0 })).toMatchObject({
      bandMinAdc: 0,
      platformFeeCents: 100_000,
    });
  });

  it("a band edge moves the flat fee: ADC 9 vs 10, 16 vs 17, 25 vs 26 and 29 vs 30", () => {
    const fee = (patients: number) => price({ adcHundredths: adc(patients) }).platformFeeCents;
    expect([fee(9), fee(10), fee(16), fee(17), fee(25), fee(26), fee(29), fee(30)]).toEqual([
      100_000, 200_000, 200_000, 300_000, 300_000, 400_000, 400_000, 500_000,
    ]);
  });
});

describe("billingFeeCents", () => {
  it("is 0 when the tenant bills outside ChartWarden, whatever it collected", () => {
    expect(price({ mode: "none", netCollectionsCents: 5_000_000_00 }).billingFeeCents).toBe(0);
    expect(price({ mode: "none", netCollectionsCents: 5_000_000_00 }).billingBps).toBe(0);
  });

  it("uses the billing_software rate for billing_software and the managed rate for managed_billing", () => {
    expect(price({ mode: "billing_software", netCollectionsCents: 10_000_000 })).toMatchObject({
      billingBps: 100,
      billingFeeCents: 100_000,
    });
    expect(price({ mode: "managed_billing", netCollectionsCents: 10_000_000 })).toMatchObject({
      billingBps: 400,
      billingFeeCents: 400_000,
    });
  });

  it("rounds to the nearest cent, halves up", () => {
    expect(billingFeeCents(1_050, 100)).toBe(11); // 10.5 -> 11
    expect(billingFeeCents(1_049, 100)).toBe(10); // 10.49 -> 10
    expect(billingFeeCents(333, 100)).toBe(3); // 3.33 -> 3
    expect(billingFeeCents(1, 5_000)).toBe(1); // 0.5 -> 1
  });

  it("never charges a negative fee when refunds and takebacks exceeded payments in the month", () => {
    expect(billingFeeCents(-250_000, 300)).toBe(0);
    expect(price({ mode: "billing_software", netCollectionsCents: -1 }).billingFeeCents).toBe(0);
  });

  it("is 0 on zero collections", () => {
    expect(billingFeeCents(0, 300)).toBe(0);
  });

  it("stays exact at the top of the safe-integer range, where a float product loses digits (BigInt, no drift)", () => {
    // 9_007_199_254_740_991 x 9_999 = 90_062_985_348_155_173_009 needs 67 bits; the float product rounds it, so a Number
    // implementation answers 9_006_298_534_815_518 (or worse). Exact: (product + 5_000) / 10_000, truncated.
    const exact = 9_006_298_534_815_517;
    expect(billingFeeCents(9_007_199_254_740_991, 9_999)).toBe(exact);
    const floatAnswer = Math.floor((9_007_199_254_740_991 * 9_999 + 5_000) / 10_000);
    expect(floatAnswer).not.toBe(exact); // the test discriminates: the naive float formula is wrong here
  });
});

describe("computeStatementAmounts: minimum, one-time fee, total", () => {
  it("total is platform fee + billing fee + one-time fee", () => {
    const r = price({
      staffCount: 30,
      adcHundredths: adc(12),
      mode: "billing_software",
      netCollectionsCents: 10_000_000,
      oneTimeFeeCents: 500_000,
    });
    expect(r.platformFeeCents).toBe(300_000);
    expect(r.billingFeeCents).toBe(100_000);
    expect(r.totalCents).toBe(300_000 + 100_000 + 500_000);
    expect(r.minimumAdjustmentCents).toBe(0);
  });

  it("an optional minimum tops the recurring charge up and names the top-up", () => {
    const withMin: PlanPricing = { ...PLAN, minimumMonthlyCents: 450_000 };
    const r = computeStatementAmounts(withMin, {
      staffCount: 0,
      adcHundredths: adc(1),
      netCollectionsCents: 0,
      mode: "none",
      oneTimeFeeCents: 0,
    });
    expect(r.platformFeeCents).toBe(100_000);
    expect(r.minimumAdjustmentCents).toBe(350_000);
    expect(r.totalCents).toBe(450_000);
  });

  it("a minimum below the recurring charge changes nothing, and never discounts the one-time fee", () => {
    const withMin: PlanPricing = { ...PLAN, minimumMonthlyCents: 50_000 };
    const r = computeStatementAmounts(withMin, {
      staffCount: 0,
      adcHundredths: 0,
      netCollectionsCents: 0,
      mode: "none",
      oneTimeFeeCents: 25_000,
    });
    expect(r.minimumAdjustmentCents).toBe(0);
    expect(r.totalCents).toBe(125_000);
  });

  it("staff x per-user price stays exact at the plan caps (1,000,000 staff x 1,000,000,000 cents = 10^15) and refuses a product a double cannot hold", () => {
    const heavy: PlanPricing = { ...PLAN, perUserPriceCents: 1_000_000_000 };
    const run = (staffCount: number, perUserPriceCents = heavy.perUserPriceCents) =>
      computeStatementAmounts(
        { ...heavy, perUserPriceCents },
        { staffCount, adcHundredths: 0, netCollectionsCents: 0, mode: "none", oneTimeFeeCents: 0 },
      );
    expect(run(1_000_000).perUserSubtotalCents).toBe(1_000_000_000_000_000);
    expect(run(1_000_000).totalCents).toBe(1_000_000_000_000_000);
    // 10^16 is beyond 2^53: a silent float product would be rounded, so the math refuses it
    expect(() => run(10_000_000)).toThrow(RangeError);
    expect(() => run(1_000_000, 10_000_000_000)).toThrow(RangeError);
  });

  it("rejects counts that are negative or fractional rather than pricing them", () => {
    expect(() => price({ staffCount: -1 })).toThrow();
    expect(() => price({ staffCount: 1.5 })).toThrow();
    expect(() => price({ adcHundredths: -1 })).toThrow();
    expect(() => price({ netCollectionsCents: 1.5 })).toThrow();
  });
});

describe("prorateCents: the first month is charged by the days live (half-up to the cent)", () => {
  it("is the amount unchanged for a whole month and 0 for no live days", () => {
    expect(prorateCents(200_000, 30, 30)).toBe(200_000);
    expect(prorateCents(200_000, 0, 30)).toBe(0);
  });

  it("a mid-month go-live: 11 live days of a 30-day month on a $2,000 fee = $733.33", () => {
    expect(prorateCents(200_000, 11, 30)).toBe(73_333); // 73,333.33 -> 73,333
  });

  it("a go-live on the LAST day is one day of the month: $2,000 / 30 = $66.67 (66.666 half-up)", () => {
    expect(prorateCents(200_000, 1, 30)).toBe(6_667);
  });

  it("rounds a half cent up", () => {
    expect(prorateCents(1, 1, 2)).toBe(1); // 0.5
    expect(prorateCents(3, 1, 2)).toBe(2); // 1.5
    expect(prorateCents(1, 1, 3)).toBe(0); // 0.33
    expect(prorateCents(5, 1, 3)).toBe(2); // 1.67
  });

  it("stays exact where a float product loses digits (BigInt, no drift)", () => {
    // 9_007_199_254_740_991 x 13 / 30 = 3_903_119_677_054_429.4 -> ...429; the float formula lands on ...430
    expect(prorateCents(9_007_199_254_740_991, 13, 30)).toBe(3_903_119_677_054_429);
    expect(Math.floor((9_007_199_254_740_991 * 13 * 2 + 30) / 60)).not.toBe(3_903_119_677_054_429);
  });

  it("refuses days that cannot exist rather than pricing them", () => {
    expect(() => prorateCents(100, 31, 30)).toThrow(RangeError);
    expect(() => prorateCents(100, -1, 30)).toThrow(RangeError);
    expect(() => prorateCents(100, 1.5, 30)).toThrow(RangeError);
    expect(() => prorateCents(100, 1, 0)).toThrow(RangeError);
    expect(() => prorateCents(-1, 1, 30)).toThrow(RangeError);
  });
});

describe("computeStatementAmounts: proration (D2) and the minimum floors the PLATFORM FEE only (D3)", () => {
  const november = (daysLive: number) => ({ daysLive, daysInPeriod: 30 });
  const base = {
    staffCount: 0,
    adcHundredths: adc(12),
    netCollectionsCents: 0,
    mode: "none" as const,
    oneTimeFeeCents: 0,
  };

  it("prorates the platform fee of the band: go-live Nov 20 (11 live days) on the $2,000 band = $733.33; the full-month sides stay full", () => {
    const r = computeStatementAmounts(PLAN, { ...base, proration: november(11) });
    expect(r).toMatchObject({
      bandFeeCents: 200_000, // the full-month side is shown whole
      perUserSubtotalCents: 0,
      platformFeeCents: 73_333,
      platformFeeBasis: "census_band",
      totalCents: 73_333,
    });
  });

  it("a go-live on the 1st is a whole month; a go-live on the last day is one day", () => {
    expect(
      computeStatementAmounts(PLAN, { ...base, proration: november(30) }).platformFeeCents,
    ).toBe(200_000);
    expect(
      computeStatementAmounts(PLAN, { ...base, proration: november(1) }).platformFeeCents,
    ).toBe(6_667);
  });

  it("prorates the per-user side when it wins: 30 staff x $100 = $3,000, 11 of 30 days = $1,100", () => {
    const r = computeStatementAmounts(PLAN, { ...base, staffCount: 30, proration: november(11) });
    expect(r).toMatchObject({ platformFeeBasis: "per_user", platformFeeCents: 110_000 });
  });

  it("the billing fee is NOT prorated (it is on what was collected); the one-time fee is not either", () => {
    const r = computeStatementAmounts(PLAN, {
      ...base,
      mode: "billing_software",
      netCollectionsCents: 1_500_050,
      oneTimeFeeCents: 250_000,
      proration: november(11),
    });
    expect(r.billingFeeCents).toBe(15_001); // 1% of $15,000.50, half up
    expect(r.totalCents).toBe(73_333 + 15_001 + 250_000);
  });

  it("the minimum floors the platform fee and the billing fee is added ON TOP: a $1,500 minimum under a $1,000 band tops up $500 although the 1% billing fee ($1,000) would have cleared it under the old recurring-charge rule", () => {
    const withMin: PlanPricing = { ...PLAN, minimumMonthlyCents: 150_000 };
    const r = computeStatementAmounts(withMin, {
      ...base,
      adcHundredths: adc(1),
      mode: "billing_software",
      netCollectionsCents: 10_000_000,
    });
    expect(r).toMatchObject({
      platformFeeCents: 100_000,
      minimumAdjustmentCents: 50_000,
      billingFeeCents: 100_000,
      totalCents: 100_000 + 50_000 + 100_000,
    });
  });

  it("the minimum is prorated the same way in a first month: $1,500 x 11/30 = $550 floors a $333.33 prorated band fee", () => {
    const withMin: PlanPricing = { ...PLAN, minimumMonthlyCents: 150_000 };
    const r = computeStatementAmounts(withMin, {
      ...base,
      adcHundredths: adc(1),
      proration: november(11),
    });
    // band $1,000 x 11/30 = 36,666.67 -> 36,667; minimum 150,000 x 11/30 = 55,000
    expect(r.platformFeeCents).toBe(36_667);
    expect(r.minimumAdjustmentCents).toBe(18_333);
    expect(r.totalCents).toBe(55_000);
  });

  it("a prior-period billing fee is added to the total and never touches the platform fee or the minimum", () => {
    const withMin: PlanPricing = { ...PLAN, minimumMonthlyCents: 150_000 };
    const r = computeStatementAmounts(withMin, {
      ...base,
      adcHundredths: adc(1),
      priorPeriodFeeCents: 40_000,
    });
    expect(r.minimumAdjustmentCents).toBe(50_000);
    expect(r.priorPeriodFeeCents).toBe(40_000);
    expect(r.totalCents).toBe(100_000 + 50_000 + 40_000);
  });
});

describe("lateCollectionsCents: money that posted after its month closed (D4)", () => {
  it("is what the month collected now, less what its statement billed and what was already carried", () => {
    // November was finalized on $16,500.50; $40,000.00 dated Nov 29 posted on Dec 8
    expect(lateCollectionsCents(5_650_050, 1_650_050, 0)).toBe(4_000_000);
    // carried once already: the same $40,000 is not carried again
    expect(lateCollectionsCents(5_650_050, 1_650_050, 4_000_000)).toBe(0);
    // a further $100.00 posts later
    expect(lateCollectionsCents(5_660_050, 1_650_050, 4_000_000)).toBe(10_000);
  });

  it("is never negative: a correction downward is not a credit on a later statement", () => {
    expect(lateCollectionsCents(1_000_000, 1_650_050, 0)).toBe(0);
    expect(lateCollectionsCents(0, 0, 0)).toBe(0);
  });

  it("refuses a fractional or unsafe cent figure", () => {
    expect(() => lateCollectionsCents(1.5, 0, 0)).toThrow(RangeError);
    expect(() => lateCollectionsCents(Number.MAX_SAFE_INTEGER + 2, 0, 0)).toThrow(RangeError);
  });
});

describe("averageDailyCensusHundredths", () => {
  it("is the mean of the observed days, in hundredths of a patient", () => {
    expect(averageDailyCensusHundredths([10, 12, 14])).toEqual({ adcHundredths: 1_200, days: 3 });
    expect(averageDailyCensusHundredths([10, 11])).toEqual({ adcHundredths: 1_050, days: 2 });
  });

  it("rounds a repeating mean half up to the hundredth", () => {
    expect(averageDailyCensusHundredths([1, 1, 2]).adcHundredths).toBe(133); // 1.333..
    expect(averageDailyCensusHundredths([1, 2, 2]).adcHundredths).toBe(167); // 1.666..
  });

  it("has no days, and so no census, when nothing was observed", () => {
    expect(averageDailyCensusHundredths([])).toEqual({ adcHundredths: 0, days: 0 });
  });

  it("a zero-patient month is a real zero, not a missing one", () => {
    expect(averageDailyCensusHundredths([0, 0, 0])).toEqual({ adcHundredths: 0, days: 3 });
  });

  it("refuses a negative or fractional daily count", () => {
    expect(() => averageDailyCensusHundredths([3, -1])).toThrow();
    expect(() => averageDailyCensusHundredths([3, 1.5])).toThrow();
  });
});

describe("validatePlanPricing", () => {
  const ok = { ...PLAN, contractTermMonths: 12, implementationFeeCents: 250_000 };

  it("accepts a complete plan", () => {
    expect(validatePlanPricing(ok)).toEqual([]);
  });

  it("requires the first band to start at 0, strictly ascending thresholds, no duplicates", () => {
    const codes = (bands: CensusBand[]) => validatePlanPricing({ ...ok, bands }).map((e) => e.code);
    expect(codes([{ minAdc: 1, monthlyFeeCents: 1 }])).toContain("BAND_ZERO_REQUIRED");
    expect(
      codes([
        { minAdc: 0, monthlyFeeCents: 1 },
        { minAdc: 10, monthlyFeeCents: 2 },
        { minAdc: 10, monthlyFeeCents: 3 },
      ]),
    ).toContain("BAND_THRESHOLD_DUPLICATE");
    expect(codes([])).toContain("BAND_ZERO_REQUIRED");
  });

  it("does not let a higher census cost less than a lower one", () => {
    expect(
      validatePlanPricing({
        ...ok,
        bands: [
          { minAdc: 0, monthlyFeeCents: 200_000 },
          { minAdc: 10, monthlyFeeCents: 100_000 },
        ],
      }).map((e) => e.code),
    ).toContain("BAND_FEE_NOT_ASCENDING");
  });

  it("bounds money and rates: integers, non-negative, bps within 0..10000", () => {
    const codes = (over: Partial<typeof ok>) =>
      validatePlanPricing({ ...ok, ...over }).map((e) => e.field);
    expect(codes({ perUserPriceCents: -1 })).toContain("perUserPriceCents");
    expect(codes({ perUserPriceCents: 1.5 })).toContain("perUserPriceCents");
    expect(codes({ billingSoftwareBps: 10_001 })).toContain("billingSoftwareBps");
    expect(codes({ managedBillingBps: -1 })).toContain("managedBillingBps");
    expect(codes({ contractTermMonths: 0 })).toContain("contractTermMonths");
    expect(codes({ implementationFeeCents: -5 })).toContain("implementationFeeCents");
    expect(codes({ minimumMonthlyCents: -5 })).toContain("minimumMonthlyCents");
  });

  it("requires managed billing to cost at least as much as billing software", () => {
    expect(
      validatePlanPricing({ ...ok, billingSoftwareBps: 300, managedBillingBps: 100 }).map(
        (e) => e.code,
      ),
    ).toContain("MANAGED_RATE_BELOW_SOFTWARE");
  });
});

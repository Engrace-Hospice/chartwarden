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
  selectCensusBand,
  validatePlanPricing,
} from "../src/pricing";

// Demo prices only: the platform never hardcodes them, a plan carries them.
const BANDS: readonly CensusBand[] = [
  { minAdc: 0, monthlyFeeCents: 100_000 },
  { minAdc: 10, monthlyFeeCents: 200_000 },
  { minAdc: 17, monthlyFeeCents: 300_000 },
  { minAdc: 26, monthlyFeeCents: 400_000 },
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
  it("are the owner's 0-9, 10-16, 17-25 and 26+ (26 closes the owner's 25-to-30 gap and is editable data)", () => {
    expect(DEFAULT_CENSUS_BAND_THRESHOLDS).toEqual([0, 10, 17, 26]);
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
    ["26 starts the last band", 26, 26],
    ["a very large census stays in the last band", 5_000, 26],
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

  it("a band edge moves the flat fee: ADC 9 vs 10 and 16 vs 17 and 25 vs 26", () => {
    const fee = (patients: number) => price({ adcHundredths: adc(patients) }).platformFeeCents;
    expect([fee(9), fee(10), fee(16), fee(17), fee(25), fee(26)]).toEqual([
      100_000, 200_000, 200_000, 300_000, 300_000, 400_000,
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

  it("is 0 on zero collections and stays exact on very large ones (no float drift)", () => {
    expect(billingFeeCents(0, 300)).toBe(0);
    expect(billingFeeCents(9_007_199_254_740_000, 1)).toBe(900_719_925_474);
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

  it("rejects counts that are negative or fractional rather than pricing them", () => {
    expect(() => price({ staffCount: -1 })).toThrow();
    expect(() => price({ staffCount: 1.5 })).toThrow();
    expect(() => price({ adcHundredths: -1 })).toThrow();
    expect(() => price({ netCollectionsCents: 1.5 })).toThrow();
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

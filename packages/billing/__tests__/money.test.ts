import {
  allocateProportional,
  applySequestration,
  applyWageIndexFactor,
  fromDecimal,
  lineChargeCents,
  perDiemAmountCents,
  ratio,
  sumCents,
  toDecimal,
} from "@wardenx/billing";
// @wardenx/billing — M23 money/rate KERNEL (D6 / D7 / D11 / §2.6) pure-domain tests.
//
// Billing math is REGULATORY math — a cent off in a claim line is a real Medicare-payment consequence — so
// all amounts cross boundaries as INTEGER CENTS and the only fractional arithmetic is internal (decimal.js)
// with an EXPLICIT HALF-UP rounding mode. The largest-remainder allocator is penny-true: parts sum EXACTLY
// to the total (zero float drift). The billing-specific primitives (per-diem, line-charge, wage-index,
// sequestration, ratio) round HALF-UP at whole cents and reject negative/non-finite inputs. Pure: no I/O.
import { describe, expect, it } from "vitest";

describe("allocateProportional — sum-preservation invariant (no penny drift)", () => {
  const vectors: ReadonlyArray<readonly [number, readonly number[]]> = [
    [100, [1, 1, 1]],
    [1000, [3, 5, 2]],
    [9999, [1, 2, 3, 4, 5, 6, 7]],
    [1, [1, 1, 1, 1]],
    [7, [2, 2, 2]],
    [123_456, [10, 20, 30, 17]],
    [1_000_000, [333, 333, 334]],
    [50, [0, 0, 0, 0, 0]], // zero-sum → equal split
    [101, [5, 0, 0]], // a zero weight alongside non-zero
    [0, [1, 2, 3]], // zero total
    [156_000, [7, 1]], // an 8-day RHC claim's per-diem split across two buckets
  ];

  for (const [total, weights] of vectors) {
    it(`parts of allocate(${total}, [${weights.join(",")}]) sum exactly to ${total}`, () => {
      const parts = allocateProportional(total, weights);
      expect(parts).toHaveLength(weights.length);
      expect(sumCents(parts)).toBe(total);
      for (const p of parts) expect(Number.isInteger(p)).toBe(true);
    });
  }

  it("preserves the sum for a negative total (apportioned reduction/credit)", () => {
    expect(sumCents(allocateProportional(-100, [1, 1, 1]))).toBe(-100);
  });

  it("never drifts across a large fuzz of (total, weights) draws (deterministic LCG)", () => {
    let seed = 0x2bad_c0de;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff);
    for (let t = 0; t < 2_000; t++) {
      const total = (next() % 2_000_001) - 1_000_000; // ±$10,000
      const n = (next() % 8) + 1;
      const weights = Array.from({ length: n }, () => next() % 1_000);
      const parts = allocateProportional(total, weights);
      expect(sumCents(parts)).toBe(total);
    }
  });
});

describe("allocateProportional — largest-remainder correctness + index tie-break", () => {
  it("allocate 100 by [1,1,1] → [34,33,33] (ties broken by ascending index)", () => {
    expect(allocateProportional(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("hands residual cents to the largest fractional remainders first", () => {
    expect(allocateProportional(10, [1, 1, 1, 1, 3])).toEqual([2, 2, 1, 1, 4]);
  });

  it("two cents over [1,1] splits to [1,1]", () => {
    expect(allocateProportional(2, [1, 1])).toEqual([1, 1]);
  });
});

describe("allocateProportional — zero-sum weights fall back to an equal split", () => {
  it("allocate 100 by [0,0,0] → [34,33,33]", () => {
    expect(allocateProportional(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  it("allocate 12 by [0,0,0,0] → [3,3,3,3]", () => {
    expect(allocateProportional(12, [0, 0, 0, 0])).toEqual([3, 3, 3, 3]);
  });
});

describe("allocateProportional — input validation + empty", () => {
  it("empty weights → []", () => expect(allocateProportional(100, [])).toEqual([]));
  it("a negative weight throws RangeError", () =>
    expect(() => allocateProportional(100, [1, -1, 1])).toThrow(RangeError));
  it("a NaN weight throws RangeError", () =>
    expect(() => allocateProportional(100, [1, Number.NaN])).toThrow(RangeError));
  it("an Infinity weight throws RangeError", () =>
    expect(() => allocateProportional(100, [Number.POSITIVE_INFINITY, 1])).toThrow(RangeError));
});

describe("fromDecimal — HALF-UP rounding at whole cents", () => {
  it("rounds 1.5 → 2 (half away from zero)", () =>
    expect(fromDecimal(toDecimal(3).div(2))).toBe(2));
  it("rounds -1.5 → -2 (half away from zero for negatives)", () =>
    expect(fromDecimal(toDecimal(-3).div(2))).toBe(-2));
  it("rounds 2.5 → 3", () => expect(fromDecimal(toDecimal(5).div(2))).toBe(3));
  it("rounds 4/3 = 1.333 → 1", () => expect(fromDecimal(toDecimal(4).div(3))).toBe(1));
  it("an already-integer decimal is unchanged", () => expect(fromDecimal(toDecimal(42))).toBe(42));
});

describe("sumCents — exact integer sum", () => {
  it("empty vector → 0", () => expect(sumCents([])).toBe(0));
  it("sums positive and negative cents exactly", () => expect(sumCents([100, -25, 5, 0])).toBe(80));
  it("single element returns itself", () => expect(sumCents([777])).toBe(777));
});

describe("perDiemAmountCents — rate × days (exact integer cents)", () => {
  it("multiplies a per-diem by a day count exactly", () => {
    expect(perDiemAmountCents(20_000, 7)).toBe(140_000);
  });

  it("zero days → 0", () => expect(perDiemAmountCents(20_000, 0)).toBe(0));

  it("does not drift for a large day count", () => {
    expect(perDiemAmountCents(16_000, 365)).toBe(5_840_000);
  });

  it("throws on a non-integer day count", () => {
    expect(() => perDiemAmountCents(20_000, 1.5)).toThrow(RangeError);
  });

  it("throws on a negative day count", () => {
    expect(() => perDiemAmountCents(20_000, -1)).toThrow(RangeError);
  });
});

describe("lineChargeCents — unitCount × unitRate, HALF-UP at whole cents", () => {
  it("prices an integer unit count exactly", () => expect(lineChargeCents(4, 6_000)).toBe(24_000));

  it("prices a fractional unit count (CHC quarter-hours)", () => {
    expect(lineChargeCents(1.5, 6_000)).toBe(9_000);
    expect(lineChargeCents(0.25, 6_000)).toBe(1_500);
  });

  it("rounds a half-cent product HALF-UP", () => {
    // 1.5 × 6017 = 9025.5 → 9026.
    expect(lineChargeCents(1.5, 6_017)).toBe(9_026);
  });

  it("zero unit count → 0", () => expect(lineChargeCents(0, 6_000)).toBe(0));

  it("throws on a negative unit count", () =>
    expect(() => lineChargeCents(-1, 6_000)).toThrow(RangeError));
  it("throws on a non-finite unit rate", () =>
    expect(() => lineChargeCents(1, Number.POSITIVE_INFINITY)).toThrow(RangeError));
});

describe("applyWageIndexFactor — base rate × factor, HALF-UP at whole cents", () => {
  it("identity at factor 1.0000", () =>
    expect(applyWageIndexFactor(20_000, "1.0000")).toBe(20_000));

  it("scales by a sub-1 factor", () => {
    // 20000 × 0.9234 = 18468.0 (exact).
    expect(applyWageIndexFactor(20_000, "0.9234")).toBe(18_468);
  });

  it("scales by an above-1 factor", () => {
    expect(applyWageIndexFactor(20_000, "1.1500")).toBe(23_000);
  });

  it("factor 0 → 0", () => expect(applyWageIndexFactor(20_000, "0")).toBe(0));

  it("rounds HALF-UP at a half-cent product", () => {
    // 12345 × 0.5 = 6172.5 → 6173.
    expect(applyWageIndexFactor(12_345, "0.5")).toBe(6_173);
  });

  it("throws on a negative factor", () =>
    expect(() => applyWageIndexFactor(20_000, "-0.5")).toThrow(RangeError));
});

describe("applySequestration — money split sums exactly to the gross", () => {
  it("2% of 100000 → reduction 2000, net 98000 (sum 100000)", () => {
    const r = applySequestration(100_000, "2.0");
    expect(r.reductionCents).toBe(2_000);
    expect(r.netCents).toBe(98_000);
    expect(r.netCents + r.reductionCents).toBe(100_000);
  });

  it("rounds the reduction HALF-UP (25 × 2% = 0.5 → 1)", () => {
    const r = applySequestration(25, "2.0");
    expect(r.reductionCents).toBe(1);
    expect(r.netCents).toBe(24);
  });

  it("throws on a percent outside [0, 100]", () => {
    expect(() => applySequestration(100, "150")).toThrow(RangeError);
    expect(() => applySequestration(100, "-1")).toThrow(RangeError);
  });
});

describe("ratio — exact dimensionless fraction", () => {
  it("computes an exact ratio in the decimal domain", () => {
    expect(ratio(1, 4).toNumber()).toBe(0.25);
  });

  it("can be chained into a further cents multiply without an intermediate round", () => {
    // 10000 cents × (1/3) ratio → 3333.33… → 3333 HALF-UP at whole cents.
    expect(fromDecimal(toDecimal(10_000).times(ratio(1, 3)))).toBe(3_333);
  });

  it("throws on a zero denominator", () => expect(() => ratio(100, 0)).toThrow(RangeError));
});

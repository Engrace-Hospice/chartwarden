import { allocateProportional, fromDecimal, sumCents, toDecimal } from "@chartwarden/cost-report";
// @chartwarden/cost-report — M27 money/ratio kernel (D8) pure-domain unit tests.
//
// The proportional allocator is REGULATORY math: parts must sum EXACTLY to the input total (the CMS
// step-down "no penny drift" invariant), the largest-remainder split must be deterministic with an
// index tie-break, and a zero-sum weight vector must fall back to an equal split rather than throw away
// the total. fromDecimal rounds HALF-UP (away from zero) at whole cents. sumCents is exact.
import { describe, expect, it } from "vitest";

describe("allocateProportional — sum-preservation invariant (no penny drift)", () => {
  // A handful of fixed (total, weights) vectors; the universal post-condition is that the parts sum
  // EXACTLY to the input total, regardless of how the residual cents land.
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
    const parts = allocateProportional(-100, [1, 1, 1]);
    expect(sumCents(parts)).toBe(-100);
  });
});

describe("allocateProportional — largest-remainder correctness + index tie-break", () => {
  it("allocate 100 by [1,1,1] → [34,33,33] (ties broken by ascending index)", () => {
    // ideal share each = 33.333…, floor 33, residual = 1; all three remainders equal so the single
    // leftover cent goes to the lowest index.
    expect(allocateProportional(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("hands residual cents to the largest fractional remainders first", () => {
    // total 10 over weights [1,1,1,1,3]: denom 7, ideals = 1.428,1.428,1.428,1.428,4.285;
    // floors 1,1,1,1,4 (sum 8); residual 2 → remainders .428 (x4) and .285; the two largest (idx 0,1)
    // get +1 each by ascending-index tie-break.
    expect(allocateProportional(10, [1, 1, 1, 1, 3])).toEqual([2, 2, 1, 1, 4]);
  });

  it("two cents over [1,1] splits to [1,1]", () => {
    expect(allocateProportional(2, [1, 1])).toEqual([1, 1]);
  });
});

describe("allocateProportional — zero-sum weights fall back to an equal split", () => {
  it("allocate 100 by [0,0,0] → equal split [34,33,33] summing to 100", () => {
    const parts = allocateProportional(100, [0, 0, 0]);
    expect(sumCents(parts)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it("allocate 12 by [0,0,0,0] → [3,3,3,3]", () => {
    expect(allocateProportional(12, [0, 0, 0, 0])).toEqual([3, 3, 3, 3]);
  });
});

describe("allocateProportional — input validation + empty", () => {
  it("empty weights → []", () => {
    expect(allocateProportional(100, [])).toEqual([]);
  });

  it("a negative weight throws RangeError", () => {
    expect(() => allocateProportional(100, [1, -1, 1])).toThrow(RangeError);
  });

  it("a NaN weight throws RangeError", () => {
    expect(() => allocateProportional(100, [1, Number.NaN])).toThrow(RangeError);
  });

  it("an Infinity weight throws RangeError", () => {
    expect(() => allocateProportional(100, [Number.POSITIVE_INFINITY, 1])).toThrow(RangeError);
  });
});

describe("fromDecimal — HALF-UP rounding at whole cents", () => {
  it("rounds 1.5 → 2 (half away from zero)", () => {
    expect(fromDecimal(toDecimal(3).div(2))).toBe(2);
  });

  it("rounds -1.5 → -2 (half away from zero for negatives)", () => {
    expect(fromDecimal(toDecimal(-3).div(2))).toBe(-2);
  });

  it("rounds 2.5 → 3", () => {
    expect(fromDecimal(toDecimal(5).div(2))).toBe(3);
  });

  it("rounds 0.4-ish down: 4/3 = 1.333 → 1", () => {
    expect(fromDecimal(toDecimal(4).div(3))).toBe(1);
  });

  it("an already-integer decimal is unchanged", () => {
    expect(fromDecimal(toDecimal(42))).toBe(42);
  });
});

describe("sumCents — exact integer sum", () => {
  it("empty vector → 0", () => {
    expect(sumCents([])).toBe(0);
  });

  it("sums positive and negative cents exactly", () => {
    expect(sumCents([100, -25, 5, 0])).toBe(80);
  });

  it("single element returns itself", () => {
    expect(sumCents([777])).toBe(777);
  });
});

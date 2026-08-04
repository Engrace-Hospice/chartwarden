// @wardenx/shared — the shared penny-exact money KERNEL (ARCH-021). The single arithmetic primitive
// every regulatory-math package converges on: M23 billing (HIPPS per-diem / SIA / sequestration / wage
// index), M27 cost-report (worksheet allocation / step-down apportionment / settlement), and M26
// cap-management (per-beneficiary accrual rounding). This math is REGULATORY math — a cent off is a real
// CMS-payment consequence and an audit trigger — so all amounts cross every module boundary as INTEGER
// CENTS (a whole-number `number`) and the only place fractional arithmetic exists is INTERNAL to these
// functions, via `decimal.js`, immediately rounded back to whole cents with an EXPLICIT, deterministic
// rounding mode (no float, no global rounding-mode reliance — every rounding call names its mode). The
// proportional allocator is penny-true (largest-remainder apportionment): the parts sum EXACTLY to the
// input total, so apportioning a total across line items / cost centers / beneficiaries never drifts a
// cent. No PHI — aggregate financial values only.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`. Types, pure
// functions, constants only. `decimal.js` is the sole dependency and is used internally-only.
//
// Previously this kernel (toDecimal/fromDecimal/sumCents/ratio/allocateProportional) was copied verbatim
// into packages/billing/src/domain/money.ts and packages/cost-report/src/domain/money.ts, with
// packages/cap-management/src/money.ts adding a third, differently-shaped rounding primitive. Both
// module money.ts files now re-export this kernel and keep only their module-specific rate primitives;
// cap-management's `roundCents` delegates to `fromDecimal` here (same half-away-from-zero convention).
import { Decimal } from "decimal.js";

/**
 * Integer cents — the canonical boundary representation of money in every regulatory-math package.
 * Always a whole number (positive for charges/credits, negative for adjustments/reductions/reductions
 * withheld). Never a fractional dollar value; never a float-dollar. The `decimal.js` form exists only
 * inside this module and callers that lift a non-cents decimal string (a rate factor, a percentage) into
 * the same exact domain.
 */
export type Cents = number;

/**
 * The shared `decimal.js` constructor clone every regulatory calculator uses, isolated so nothing this
 * module (or a caller lifting a rate/percentage string) mutates the global `Decimal` config another
 * package might rely on. Precision 40 significant digits comfortably covers a multi-segment per-diem ×
 * wage-index multiplication or a national-chain cost-report step-down without intermediate-precision
 * loss; the rounding mode is passed EXPLICITLY at every `toDecimalPlaces` call rather than read from this
 * default, so the math is deterministic regardless of any caller's global `Decimal.set(...)`. Exported so
 * a module-specific rate primitive (e.g. billing's wage-index factor, sequestration percent) can lift a
 * decimal STRING into the same exact domain without re-cloning `decimal.js` itself.
 */
export const RegulatoryDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Lift integer cents into the internal `decimal.js` domain for exact intermediate arithmetic. */
export function toDecimal(cents: Cents): Decimal {
  return new RegulatoryDecimal(cents);
}

/**
 * Collapse an internal `decimal.js` value back to whole integer cents, rounding HALF-UP (0.5 rounds
 * away from zero: 1.5 → 2, -1.5 → -2). Half-up is the deterministic, CMS-conventional rounding for
 * regulatory dollar lines; it is named explicitly here so the behavior never silently follows a global
 * mode change. The result is a plain integer `number` suitable to cross any boundary.
 */
export function fromDecimal(d: Decimal): Cents {
  return d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/**
 * Round a fractional cents value to a whole-cent integer, HALF-UP (the same accounting convention as
 * `fromDecimal`, exposed as a plain `number -> number` convenience for callers that never leave the
 * `decimal.js` domain themselves — e.g. a projection whose input is already a float division).
 */
export function roundCents(value: number): Cents {
  return fromDecimal(new RegulatoryDecimal(value));
}

/** Exact sum of a cents vector. Inputs are whole cents, so the sum is exact without `decimal.js`. */
export function sumCents(parts: readonly Cents[]): Cents {
  let total = 0;
  for (const p of parts) total += p;
  return total;
}

/**
 * Exact ratio of two cents quantities as a `decimal.js` value (NOT rounded to cents — a ratio is a
 * dimensionless fraction). Kept in the `decimal.js` domain so a caller can chain it into a further
 * `toDecimal(...).times(ratio)` without an intermediate cent-round. Throws on a zero denominator rather
 * than yield a non-finite value (a zero-basis ratio is a caller bug the validation layer must surface,
 * not silently propagate as Infinity/NaN).
 */
export function ratio(numCents: Cents, denCents: Cents): Decimal {
  if (denCents === 0) {
    throw new RangeError("ratio: division by zero denominator");
  }
  return new RegulatoryDecimal(numCents).div(denCents);
}

/**
 * Penny-true proportional apportionment by the LARGEST-REMAINDER method: split `totalCents` across the
 * given non-negative `weights` so that (a) each part is whole cents, (b) the parts sum EXACTLY to
 * `totalCents` (zero penny drift), and (c) the split is fully deterministic. Each part gets the floor
 * (toward −∞) of its ideal proportional share; the residual cents left over are handed out one at a time
 * to the parts with the largest fractional remainders, ties broken by ascending index. Flooring toward
 * −∞ keeps the residual count non-negative for both positive and negative totals, so a negative
 * `totalCents` (a reduction/credit being apportioned) is handled by the same code path.
 *
 * Edge cases: an empty `weights` yields `[]`; a weights vector that sums to zero is treated as EQUAL
 * weights so the total is still distributed exactly rather than thrown away. Negative or non-finite
 * weights are a programming error and throw.
 */
export function allocateProportional(totalCents: Cents, weights: readonly number[]): Cents[] {
  const n = weights.length;
  if (n === 0) return [];
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) {
      throw new RangeError("allocateProportional: weights must be finite and non-negative");
    }
  }

  // A zero-sum weight vector cannot drive a proportional split; fall back to equal shares so the
  // total is still apportioned exactly (deterministic and sum-preserving).
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const effWeights = weightSum === 0 ? weights.map(() => 1) : weights;
  const effWeightSum = weightSum === 0 ? n : weightSum;

  const total = new RegulatoryDecimal(totalCents);
  const denom = new RegulatoryDecimal(effWeightSum);

  const floors: Decimal[] = new Array(n);
  const remainders: Decimal[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ideal = total.times(effWeights[i]!).div(denom);
    const floor = ideal.toDecimalPlaces(0, Decimal.ROUND_FLOOR);
    floors[i] = floor;
    remainders[i] = ideal.minus(floor);
  }

  const allocated = floors.reduce((acc, f) => acc.plus(f), new RegulatoryDecimal(0));
  const residual = total.minus(allocated).toNumber();

  const order = Array.from({ length: n }, (_unused, i) => i).sort((a, b) => {
    const cmp = remainders[b]!.comparedTo(remainders[a]!);
    return cmp !== 0 ? cmp : a - b;
  });

  const result: Cents[] = floors.map((f) => f.toNumber());
  for (let k = 0; k < residual; k++) {
    const idx = order[k % n]!;
    result[idx] = result[idx]! + 1;
  }
  return result;
}

// @wardenx/billing — M23 money/rate KERNEL (D6 / D7 / D11 / §2.6). The single penny-exact arithmetic
// primitive every Phase-2 calculator imports: the HIPPS per-diem builder (D7), the SIA add-on calculator
// (D6), the sequestration reducer (D11), and the wage-index-adjusted per-diem math. Billing math is
// REGULATORY math — a cent off in a claim line is a real Medicare-payment consequence and an audit
// trigger — so all amounts cross every boundary as INTEGER CENTS (a whole-number `number`) and the only
// place fractional arithmetic exists is INTERNAL to these functions, via `decimal.js`, immediately
// rounded back to whole cents with an EXPLICIT, deterministic rounding mode (no float, no global
// rounding-mode reliance — every rounding call names its mode). The proportional allocator is penny-true
// (largest-remainder apportionment): the parts sum EXACTLY to the input total so apportioning a per-diem
// total across `claim_line` rows never drifts a cent. No PHI — aggregate financial values only (D13).
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`. Types, pure
// functions, constants only. `decimal.js` is the sole dependency and is used internally-only. This file
// is the M27 `packages/cost-report/src/domain/money.ts` precedent, adapted to billing's per-diem /
// line-charge / sequestration / wage-index primitives.
import { Decimal } from "decimal.js";

/**
 * Integer cents — the canonical boundary representation of money in M23. Always a whole number
 * (positive for charges/payments, negative for adjustments/reductions). Never a fractional dollar value;
 * never a float-dollar. The `decimal.js` form exists only inside this module.
 */
export type Cents = number;

/**
 * A private `decimal.js` constructor clone with ample precision, isolated so nothing this module does
 * mutates the global `Decimal` config another package might rely on. Precision 40 significant digits
 * comfortably covers a multi-segment per-diem × wage-index multiplication without intermediate-precision
 * loss; the rounding mode is passed EXPLICITLY at every `toDecimalPlaces` call rather than read from this
 * default, so the math is deterministic regardless of any caller's global `Decimal.set(...)`.
 */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Lift integer cents into the internal `decimal.js` domain for exact intermediate arithmetic. */
export function toDecimal(cents: Cents): Decimal {
  return new D(cents);
}

/**
 * Collapse an internal `decimal.js` value back to whole integer cents, rounding HALF-UP (0.5 rounds
 * away from zero: 1.5 → 2, -1.5 → -2). Half-up is the deterministic, CMS-conventional rounding for
 * claim dollar lines; it is named explicitly here so the behavior never silently follows a global mode
 * change. The result is a plain integer `number` suitable to cross any boundary.
 */
export function fromDecimal(d: Decimal): Cents {
  return d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
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
  return new D(numCents).div(denCents);
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

  const total = new D(totalCents);
  const denom = new D(effWeightSum);

  const floors: Decimal[] = new Array(n);
  const remainders: Decimal[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ideal = total.times(effWeights[i]!).div(denom);
    const floor = ideal.toDecimalPlaces(0, Decimal.ROUND_FLOOR);
    floors[i] = floor;
    remainders[i] = ideal.minus(floor);
  }

  const allocated = floors.reduce((acc, f) => acc.plus(f), new D(0));
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

// ── billing-specific rate primitives (D6 / D7 / D11) ───────────────────────────────────────────────────

/**
 * A per-diem amount: `perDiemRateCents × days`. Both inputs are whole non-negative integers (a per-diem
 * rate is whole cents; a day count is a whole count), so the product is exact integer cents — no
 * rounding needed. Throws on a negative or non-integer day count (a caller bug). Used by the HIPPS
 * per-diem builder (D7) to total a single LOC segment's charge.
 */
export function perDiemAmountCents(perDiemRateCents: Cents, days: number): Cents {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError("perDiemAmountCents: days must be a non-negative integer");
  }
  // Exact via decimal to avoid any large-product float drift, though both operands are integers.
  return fromDecimal(new D(perDiemRateCents).times(days));
}

/**
 * A claim-line charge: `unitCount × unitRateCents`, rounded HALF-UP to whole cents. `unitCount` MAY be
 * fractional (CHC bills in 15-minute units, e.g. `3.25` hours = `13` quarter-hour units, or a fractional
 * hour representation) so the product is computed in the `decimal.js` domain and rounded explicitly.
 * `unitRateCents` is whole cents. Throws on negative/non-finite inputs.
 */
export function lineChargeCents(unitCount: number, unitRateCents: Cents): Cents {
  if (!Number.isFinite(unitCount) || unitCount < 0) {
    throw new RangeError("lineChargeCents: unitCount must be finite and non-negative");
  }
  if (!Number.isFinite(unitRateCents) || unitRateCents < 0) {
    throw new RangeError("lineChargeCents: unitRateCents must be finite and non-negative");
  }
  return fromDecimal(new D(unitRateCents).times(unitCount));
}

/**
 * Apply the CMS wage index (D12) to a base per-diem rate: `baseRateCents × factor`, rounded HALF-UP to
 * whole cents. The wage index `factorDecimal` is the platform-shared `wage_index_factor.factor_decimal`
 * value carried as a decimal STRING (e.g. `"0.9234"`) so no float ever touches the factor; it is lifted
 * into `decimal.js` exactly. Throws on a non-finite/negative factor. The *exact* CMS per-diem base rates
 * and the labor-vs-nonlabor split that the wage index applies to are an annual published table.
 * TODO(CMS-fixture): the labor-share split (apply the factor to the labor portion only) lands with the
 * HIPPS calculator's published FY rate fixture; this helper is the single-factor multiply primitive.
 */
export function applyWageIndexFactor(baseRateCents: Cents, factorDecimal: string): Cents {
  const factor = new D(factorDecimal);
  if (!factor.isFinite() || factor.isNegative()) {
    throw new RangeError("applyWageIndexFactor: factor must be finite and non-negative");
  }
  return fromDecimal(new D(baseRateCents).times(factor));
}

/** The result of a sequestration reduction: the net payable plus the reduction withheld (D11). */
export interface SequestrationResult {
  /** The amount payable AFTER the sequestration reduction (whole cents). */
  readonly netCents: Cents;
  /** The reduction withheld (whole cents); `amountCents = netCents + reductionCents` exactly. */
  readonly reductionCents: Cents;
}

/**
 * Apply the Medicare sequestration reduction (D11) to a gross payable amount: the reduction is
 * `round(amount × percent / 100)` HALF-UP, and the net is `amount − reduction` so the two parts sum back
 * to the gross EXACTLY (no penny escapes). `percent` is the active `sequestration_policy.percentage`
 * carried as a decimal STRING (e.g. `"2.0"`) — currently 2% per the CMS-announced rate. Throws on a
 * percent outside `[0, 100]`. The reduction is computed on the gross then subtracted (rather than
 * `amount × (1 − pct/100)` directly) so the withheld figure is itself a clean rounded cent value the
 * remittance can reconcile against.
 */
export function applySequestration(amountCents: Cents, percent: string): SequestrationResult {
  const pct = new D(percent);
  if (!pct.isFinite() || pct.isNegative() || pct.greaterThan(100)) {
    throw new RangeError("applySequestration: percent must be within [0, 100]");
  }
  const reductionCents = fromDecimal(new D(amountCents).times(pct).div(100));
  return { netCents: amountCents - reductionCents, reductionCents };
}

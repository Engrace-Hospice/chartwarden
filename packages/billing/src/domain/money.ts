// @chartwarden/billing — M23 money/rate primitives (D6 / D7 / D11 / §2.6). The penny-exact CENTS kernel
// (toDecimal/fromDecimal/sumCents/ratio/allocateProportional) is shared platform-wide — see
// packages/shared/src/money/kernel.ts (ARCH-021) — and re-exported below unchanged; this file adds only
// the billing-specific rate primitives every Phase-2 calculator imports: the HIPPS per-diem builder (D7),
// the SIA add-on calculator (D6), the sequestration reducer (D11), and the wage-index-adjusted per-diem
// math. Billing math is REGULATORY math — a cent off in a claim line is a real Medicare-payment
// consequence and an audit trigger.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`. Types, pure
// functions, constants only. `decimal.js` is used internally-only, via the shared kernel's
// `RegulatoryDecimal` clone (so a wage-index factor / sequestration percent string lifts into the exact
// same `decimal.js` domain as `toDecimal`/`fromDecimal`, never a separately-configured instance).
export * from "@chartwarden/shared/money";

import {
  type Cents,
  RegulatoryDecimal as D,
  fromDecimal,
  toDecimal,
} from "@chartwarden/shared/money";

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
  return fromDecimal(toDecimal(perDiemRateCents).times(days));
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
  return fromDecimal(toDecimal(unitRateCents).times(unitCount));
}

/**
 * Apply the CMS wage index (D12) to a base per-diem rate: `baseRateCents × factor`, rounded HALF-UP to
 * whole cents. The wage index `factorDecimal` is the platform-shared `wage_index_factor.factor_decimal`
 * value carried as a decimal STRING (e.g. `"0.9234"`) so no float ever touches the factor; it is lifted
 * into `decimal.js` exactly. Throws on a non-finite/negative factor. This is the WHOLE-RATE single-factor
 * multiply primitive; it is NOT how CMS applies the wage index to a hospice rate (only the LABOR SHARE is
 * adjusted) — claim pricing uses {@link applyWageIndexToLaborShare} (F-211, audit M23-F02).
 */
export function applyWageIndexFactor(baseRateCents: Cents, factorDecimal: string): Cents {
  const factor = new D(factorDecimal);
  if (!factor.isFinite() || factor.isNegative()) {
    throw new RangeError("applyWageIndexFactor: factor must be finite and non-negative");
  }
  return fromDecimal(toDecimal(baseRateCents).times(factor));
}

/**
 * F-211 (audit M23-F02, ADR-0016 D1): apply the CMS hospice wage index to the LABOR SHARE of a rate only —
 * `adjusted = base × (laborShare × wageIndex + (1 − laborShare))` — rounded HALF-UP to whole cents ONCE, at the
 * end (the non-labor share is never touched by the index). `laborShareDecimal` and `factorDecimal` are decimal
 * STRINGS lifted into `decimal.js` exactly (no float). Throws unless the labor share is within `[0, 1]` and the
 * factor is finite and non-negative. With `laborShare = 1` this equals {@link applyWageIndexFactor}.
 */
export function applyWageIndexToLaborShare(
  baseRateCents: Cents,
  factorDecimal: string,
  laborShareDecimal: string,
): Cents {
  const factor = new D(factorDecimal);
  const labor = new D(laborShareDecimal);
  if (!factor.isFinite() || factor.isNegative()) {
    throw new RangeError("applyWageIndexToLaborShare: factor must be finite and non-negative");
  }
  if (!labor.isFinite() || labor.isNegative() || labor.greaterThan(1)) {
    throw new RangeError("applyWageIndexToLaborShare: labor share must be within [0, 1]");
  }
  const multiplier = labor.times(factor).plus(new D(1).minus(labor));
  return fromDecimal(toDecimal(baseRateCents).times(multiplier));
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
  const reductionCents = fromDecimal(toDecimal(amountCents).times(pct).div(100));
  return { netCents: amountCents - reductionCents, reductionCents };
}

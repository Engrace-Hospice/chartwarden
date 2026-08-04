// @wardenx/billing — M23 money/rate primitives (D6 / D7 / D11 / §2.6). The penny-exact CENTS kernel
// (toDecimal/fromDecimal/sumCents/ratio/allocateProportional) is shared platform-wide — see
// packages/shared/src/money/kernel.ts (ARCH-021) — and re-exported below unchanged; this file adds only
// the billing-specific rate primitives every Phase-2 calculator imports: the HIPPS per-diem builder (D7),
// the SIA add-on calculator (D6), the sequestration reducer (D11), and the wage-index-adjusted per-diem
// math. Billing math is REGULATORY math — a cent off in a claim line is a real Medicare-payment
// consequence and an audit trigger.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`. Types, pure
// functions, constants only. `decimal.js` is used internally-only, via the shared kernel's
// `RegulatoryDecimal` clone (so a wage-index factor / sequestration percent string lifts into the exact
// same `decimal.js` domain as `toDecimal`/`fromDecimal`, never a separately-configured instance).
export * from "@wardenx/shared/money";

import { type Cents, fromDecimal, RegulatoryDecimal as D, toDecimal } from "@wardenx/shared/money";

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
  return fromDecimal(toDecimal(baseRateCents).times(factor));
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

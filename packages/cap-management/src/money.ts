// @wardenx/cap-management — penny-exact money + ratio kernel (§2.3: all monetary fields are BIGINT cents,
// never NUMERIC, never FLOAT). Cap dollar amounts span $30K–$40K per beneficiary × up to ~5,000 beneficiaries
// = ~$200M max, comfortably within JS safe-integer range (2^53 ≈ $90 trillion in cents), so `number` cents
// arithmetic is exact here. Percentages are computed as `number` ratios with explicit rounding at the
// 4-decimal grain the schema stores (numeric(7,4)) — the 19.99% vs 20.00% inpatient-breach edge matters.
// `roundCents` delegates to the shared kernel (packages/shared/src/money/kernel.ts, ARCH-021) — same
// half-away-from-zero convention as billing/cost-report's `fromDecimal`, so the one CMS-conventional
// rounding rule is implemented once. `ratio`/`round4`/`asPercent`/`clamp` stay local: unlike the shared
// kernel's `ratio` (a `decimal.js` value that throws on a zero denominator), these operate on plain
// `number` fractions and return `0` on a zero denominator (an open period with a zero cap denominator
// reads as 0% utilization, never NaN/Infinity) — a genuinely different domain, not a duplicate.
export { roundCents } from "@wardenx/shared/money";

/**
 * Ratio of `part` to `whole` as a fraction (e.g. 0.9512 = 95.12%). Returns 0 when `whole` is 0 — an open
 * period with a zero cap denominator reads as 0% utilization (band `safe`), never NaN/Infinity.
 */
export function ratio(part: number, whole: number): number {
  if (whole === 0) return 0;
  return part / whole;
}

/** Round a fraction to the numeric(7,4) grain the projection schema persists (e.g. 0.951234 → 0.9512). */
export function round4(fraction: number): number {
  return Math.round(fraction * 10_000) / 10_000;
}

/** A fraction (0.9512) rendered as a percentage number (95.12) at 2-decimal display grain. */
export function asPercent(fraction: number): number {
  return Math.round(fraction * 10_000) / 100;
}

/** Clamp a number into [lo, hi]. */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

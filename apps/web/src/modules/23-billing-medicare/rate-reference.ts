// apps/web/src/modules/23-billing-medicare — the PURE helpers behind the hospice rate-table screen (FY2027
// workstream E): dollars ↔ whole cents, the six rate fields, and the client-side comparison of keyed rates against
// the CMS national reference for the declared HQRP status. The comparison is the screen's LIVE hint while typing;
// the server recomputes the authoritative `nationalReferenceWarnings` on every saved version (@chartwarden/billing
// `checkRatesAgainstNationalReference`). No React, no IO.

/** The six PRE-wage-index national amounts (whole cents) — the rate-table version's rate columns. */
export interface RateSet {
  readonly rhcDays1to60PerDiemCents: number;
  readonly rhcDays61PlusPerDiemCents: number;
  readonly chcPerDiemCents: number;
  readonly chcHourlyRateCents: number;
  readonly ircPerDiemCents: number;
  readonly gipPerDiemCents: number;
}

/** GET /billing/rate-tables/national-reference → `reference`. */
export interface NationalRateReference {
  readonly fiscalYearStarting: number;
  readonly fiscalYearLabel: string;
  readonly paymentUpdatePct: number;
  readonly hqrpReductionPctPoints: number;
  readonly hqrpCompliant: RateSet;
  readonly hqrpNonCompliant: RateSet;
  readonly sources: readonly { readonly cite: string; readonly url: string }[];
  readonly note: string;
}

export type RateKey = keyof RateSet;

/** The six rate fields in CMS table order, with their revenue code and label. */
export const RATE_FIELDS: readonly { key: RateKey; label: string; revenueCode: string }[] = [
  { key: "rhcDays1to60PerDiemCents", label: "RHC days 1–60", revenueCode: "0651" },
  { key: "rhcDays61PlusPerDiemCents", label: "RHC days 61+", revenueCode: "0651" },
  { key: "chcPerDiemCents", label: "CHC per diem (24 h)", revenueCode: "0652" },
  { key: "chcHourlyRateCents", label: "CHC hourly (SIA rate)", revenueCode: "0652" },
  { key: "ircPerDiemCents", label: "Inpatient respite", revenueCode: "0655" },
  { key: "gipPerDiemCents", label: "General inpatient", revenueCode: "0656" },
];

/** `23633` → `"$236.33"`. */
export function centsToDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** `23633` → `"236.33"` (the editable field text). */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * `"236.33"` / `"$1,726.16"` → whole cents, or null when the text is not a dollar amount with at most two
 * decimals. Parsed by string, never by float multiplication, so `"236.33"` is exactly 23633.
 */
export function dollarsToCents(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return whole * 100 + frac;
}

/** `"2026"`-starting FY → `"FY2027"` (Oct 2026 – Sep 2027). */
export function fiscalYearLabel(fiscalYearStarting: number): string {
  return `FY${fiscalYearStarting + 1}`;
}

/** The federal FY starting year a date falls in (Oct–Dec belongs to the FY starting that year). */
export function fiscalYearStartingOf(date: Date): number {
  return date.getMonth() >= 9 ? date.getFullYear() : date.getFullYear() - 1;
}

/** One field that differs from the reference column. */
export interface RateMismatch {
  readonly key: RateKey;
  readonly label: string;
  readonly enteredCents: number;
  readonly referenceCents: number;
}

/** The comparison of a (possibly partial) keyed set against the reference for a declared HQRP status. */
export interface ReferenceComparison {
  /** Fields that differ from the declared column (only fields that are filled in). */
  readonly mismatches: readonly RateMismatch[];
  /** Every filled field equals the OTHER column — the classic −4 pp mix-up. */
  readonly matchesOtherColumn: boolean;
  /** How many of the six fields are filled. */
  readonly filled: number;
}

/** The reference column for a declared HQRP status. */
export function referenceColumn(ref: NationalRateReference, hqrpCompliant: boolean): RateSet {
  return hqrpCompliant ? ref.hqrpCompliant : ref.hqrpNonCompliant;
}

/** Compare keyed rates (null = not filled yet) to the reference column for the declared status. Pure. */
export function compareToReference(
  entered: Readonly<Record<RateKey, number | null>>,
  ref: NationalRateReference,
  hqrpCompliant: boolean,
): ReferenceComparison {
  const own = referenceColumn(ref, hqrpCompliant);
  const other = referenceColumn(ref, !hqrpCompliant);
  const mismatches: RateMismatch[] = [];
  let filled = 0;
  let allOther = true;
  for (const f of RATE_FIELDS) {
    const v = entered[f.key];
    if (v === null) continue;
    filled += 1;
    if (v !== own[f.key])
      mismatches.push({ key: f.key, label: f.label, enteredCents: v, referenceCents: own[f.key] });
    if (v !== other[f.key]) allOther = false;
  }
  return {
    mismatches,
    matchesOtherColumn: filled > 0 && mismatches.length > 0 && allOther,
    filled,
  };
}

/** The non-compliant update, rounded (2.3 − 4 = −1.7, not −1.7000000000000002). */
export function nonCompliantUpdatePct(ref: NationalRateReference): number {
  return Number((ref.paymentUpdatePct - ref.hqrpReductionPctPoints).toFixed(2));
}

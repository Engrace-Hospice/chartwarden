// @wardenx/billing — M23 tenant-entered hospice RATE TABLE domain (F-210). PURE: no Fastify, no Drizzle, no clock.
//
// The CMS per-diem base rates are TENANT-ENTERED (no bundled CMS data file). This module is the single home of the
// rules that keep a hand-keyed financial input honest before it reaches the database (whose CHECK / EXCLUDE
// constraints in migration 0279 are the belt to this braces): whole positive cents, a plausibility band that catches
// dollars-keyed-as-cents, the RHC tier order, the CHC hourly x24 agreement, the federal-fiscal-year window, and the
// non-overlap of effective ranges.
import type { IsoDate } from "../contracts";
import { toEpochDay } from "../domain/dates";
import type { Cents } from "../domain/money";
import type { HippsRateTable } from "../hipps/calculator";

/** The federal fiscal year (Oct 1 - Sep 30) a service date falls in, by its STARTING calendar year (2025 = FY2026). */
export function hospiceFiscalYearStartingOf(serviceDate: IsoDate): number {
  toEpochDay(serviceDate); // validates the date
  const year = Number(serviceDate.slice(0, 4));
  const month = Number(serviceDate.slice(5, 7));
  return month >= 10 ? year : year - 1;
}

/** First and last calendar day of the federal fiscal year that STARTS in `fiscalYearStarting`. */
export function fiscalYearWindow(fiscalYearStarting: number): { from: IsoDate; to: IsoDate } {
  return { from: `${fiscalYearStarting}-10-01`, to: `${fiscalYearStarting + 1}-09-30` };
}

/** Plausibility band for a per-diem, in cents ($10.00 - $10,000.00): catches "220" keyed for $220.00. */
export const RATE_PER_DIEM_MIN_CENTS = 1_000;
export const RATE_PER_DIEM_MAX_CENTS = 1_000_000;
/** Plausibility band for the CHC hourly rate, in cents ($1.00 - $1,000.00). */
export const RATE_HOURLY_MIN_CENTS = 100;
export const RATE_HOURLY_MAX_CENTS = 100_000;
/** 24 x hourly may differ from the CHC per-diem by at most this many cents (whole-cent rounding of the hourly). */
export const CHC_HOURLY_TOLERANCE_CENTS = 24;

/** The keyed rate set (all PRE-wage-index whole cents) plus its validity window. */
export interface RateTableEntry {
  readonly fiscalYearStarting: number;
  readonly effectiveFrom: IsoDate;
  /** Omitted/null = the end of the fiscal year (a rate set never silently rolls into the next year). */
  readonly effectiveTo?: IsoDate | null;
  readonly rhcDays1to60PerDiemCents: Cents;
  readonly rhcDays61PlusPerDiemCents: Cents;
  readonly chcPerDiemCents: Cents;
  readonly ircPerDiemCents: Cents;
  readonly gipPerDiemCents: Cents;
  readonly chcHourlyRateCents: Cents;
  /**
   * F-211 — the CMS-published LABOR SHARE per level of care as decimal strings (`"0.6871"`, four places at most). The wage
   * index adjusts only this share of each rate (ADR-0016 D1). Tenant-entered: no repository document states a value.
   */
  readonly laborShareRhc: string;
  readonly laborShareChc: string;
  readonly laborShareIrc: string;
  readonly laborShareGip: string;
}

/** Plausibility band for a labor share (a fraction): CMS labor shares are roughly 0.5-0.7; 68.71 (percent) is rejected. */
export const LABOR_SHARE_MIN = 0.3;
export const LABOR_SHARE_MAX = 0.9;

/** `"0.6871"`-shaped: a single-digit decimal with at most four fraction digits (matches `numeric(5,4)`). */
const LABOR_SHARE_SHAPE = /^\d(\.\d{1,4})?$/;

export type RateTableValidation =
  | { readonly ok: true; readonly effectiveTo: IsoDate }
  | { readonly ok: false; readonly errors: readonly string[] };

function isDate(s: string): boolean {
  try {
    toEpochDay(s);
    return true;
  } catch {
    return false;
  }
}

/** Validate a keyed rate entry. Returns the RESOLVED `effectiveTo` (defaulted to the fiscal-year end) or every error. */
export function validateRateTableEntry(entry: RateTableEntry): RateTableValidation {
  const errors: string[] = [];

  const perDiems: ReadonlyArray<readonly [string, number]> = [
    ["rhcDays1to60PerDiemCents", entry.rhcDays1to60PerDiemCents],
    ["rhcDays61PlusPerDiemCents", entry.rhcDays61PlusPerDiemCents],
    ["chcPerDiemCents", entry.chcPerDiemCents],
    ["ircPerDiemCents", entry.ircPerDiemCents],
    ["gipPerDiemCents", entry.gipPerDiemCents],
  ];
  for (const [name, v] of perDiems) {
    if (!Number.isInteger(v) || v <= 0) {
      errors.push(`${name} must be a positive whole number of cents`);
    } else if (v < RATE_PER_DIEM_MIN_CENTS || v > RATE_PER_DIEM_MAX_CENTS) {
      errors.push(
        `${name} (${v}) is outside the plausible band ${RATE_PER_DIEM_MIN_CENTS}-${RATE_PER_DIEM_MAX_CENTS} cents; rates are WHOLE CENTS ($220.00 is 22000, not 220)`,
      );
    }
  }
  const h = entry.chcHourlyRateCents;
  if (!Number.isInteger(h) || h <= 0) {
    errors.push("chcHourlyRateCents must be a positive whole number of cents");
  } else if (h < RATE_HOURLY_MIN_CENTS || h > RATE_HOURLY_MAX_CENTS) {
    errors.push(
      `chcHourlyRateCents (${h}) is outside the plausible band ${RATE_HOURLY_MIN_CENTS}-${RATE_HOURLY_MAX_CENTS} cents; rates are WHOLE CENTS`,
    );
  }

  for (const [name, v] of [
    ["laborShareRhc", entry.laborShareRhc],
    ["laborShareChc", entry.laborShareChc],
    ["laborShareIrc", entry.laborShareIrc],
    ["laborShareGip", entry.laborShareGip],
  ] as const) {
    if (typeof v !== "string" || !LABOR_SHARE_SHAPE.test(v)) {
      errors.push(`${name} must be a decimal fraction with at most four places, e.g. "0.6871" (not a percent)`);
    } else if (Number(v) < LABOR_SHARE_MIN || Number(v) > LABOR_SHARE_MAX) {
      errors.push(`${name} (${v}) is outside the plausible band ${LABOR_SHARE_MIN}-${LABOR_SHARE_MAX}`);
    }
  }

  if (
    Number.isInteger(entry.rhcDays1to60PerDiemCents) &&
    Number.isInteger(entry.rhcDays61PlusPerDiemCents) &&
    entry.rhcDays1to60PerDiemCents < entry.rhcDays61PlusPerDiemCents
  ) {
    errors.push("rhcDays1to60PerDiemCents must be at least rhcDays61PlusPerDiemCents (ADR-0001 tiers)");
  }
  if (
    Number.isInteger(entry.chcPerDiemCents) &&
    Number.isInteger(h) &&
    Math.abs(entry.chcPerDiemCents - 24 * h) > CHC_HOURLY_TOLERANCE_CENTS
  ) {
    errors.push(
      `chcHourlyRateCents x 24 (${24 * h}) must agree with chcPerDiemCents (${entry.chcPerDiemCents}) within ${CHC_HOURLY_TOLERANCE_CENTS} cents; one of the two is mis-keyed`,
    );
  }

  if (!Number.isInteger(entry.fiscalYearStarting) || entry.fiscalYearStarting < 2000 || entry.fiscalYearStarting > 2100) {
    errors.push("fiscalYearStarting must be a four-digit year (2025 = FY2026, Oct 2025 - Sep 2026)");
  }
  let effectiveTo: IsoDate = entry.effectiveTo ?? "";
  if (!isDate(entry.effectiveFrom)) {
    errors.push("effectiveFrom must be a valid YYYY-MM-DD date");
  } else if (Number.isInteger(entry.fiscalYearStarting)) {
    const fy = fiscalYearWindow(entry.fiscalYearStarting);
    if (effectiveTo === "") effectiveTo = fy.to;
    if (!isDate(effectiveTo)) {
      errors.push("effectiveTo must be a valid YYYY-MM-DD date");
    } else {
      if (effectiveTo < entry.effectiveFrom) errors.push("effectiveTo must not precede effectiveFrom");
      if (entry.effectiveFrom < fy.from || effectiveTo > fy.to) {
        errors.push(
          `the effective window ${entry.effectiveFrom}..${effectiveTo} must lie inside fiscal year ${entry.fiscalYearStarting} (${fy.from}..${fy.to}); enter each fiscal year as its own rate table`,
        );
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, effectiveTo };
}

/** Inclusive date ranges overlap? `to === null` is open-ended (+infinity). */
export function dateRangesOverlap(
  a: { readonly from: IsoDate; readonly to: IsoDate | null },
  b: { readonly from: IsoDate; readonly to: IsoDate | null },
): boolean {
  const aEndsBeforeBStarts = a.to !== null && a.to < b.from;
  const bEndsBeforeAStarts = b.to !== null && b.to < a.from;
  return !aEndsBeforeBStarts && !bEndsBeforeAStarts;
}

/** Does the (inclusive) window cover `date`? */
export function windowCovers(
  w: { readonly from: IsoDate; readonly to: IsoDate | null },
  date: IsoDate,
): boolean {
  return w.from <= date && (w.to === null || w.to >= date);
}

/** The persisted rate columns the calculators read. */
export interface RateTableRates {
  readonly rhcDays1to60PerDiemCents: Cents;
  readonly rhcDays61PlusPerDiemCents: Cents;
  readonly chcPerDiemCents: Cents;
  readonly ircPerDiemCents: Cents;
  readonly gipPerDiemCents: Cents;
  readonly chcHourlyRateCents: Cents;
  /** NULL on a version entered before migration 0280 (no labor shares): such a row cannot price a claim. */
  readonly laborShareRhc: string | null;
  readonly laborShareChc: string | null;
  readonly laborShareIrc: string | null;
  readonly laborShareGip: string | null;
}

/** True iff the stored version carries all four labor shares (a pre-0280 row does not). */
export function hasLaborShares(r: RateTableRates): boolean {
  return (
    r.laborShareRhc !== null &&
    r.laborShareChc !== null &&
    r.laborShareIrc !== null &&
    r.laborShareGip !== null
  );
}

/**
 * Project a stored rate set onto the `HippsRateTable` the HIPPS calculator injects. THROWS when a labor share is NULL
 * (a pre-0280 version): callers check {@link hasLaborShares} first and fail closed with a typed error.
 */
export function toHippsRateTable(r: RateTableRates): HippsRateTable {
  if (
    r.laborShareRhc === null ||
    r.laborShareChc === null ||
    r.laborShareIrc === null ||
    r.laborShareGip === null
  ) {
    throw new RangeError("toHippsRateTable: the rate table carries no labor shares (entered before migration 0280)");
  }
  return {
    rhcDays1to60PerDiemCents: r.rhcDays1to60PerDiemCents,
    rhcDays61PlusPerDiemCents: r.rhcDays61PlusPerDiemCents,
    chcHourlyRateCents: r.chcHourlyRateCents,
    ircPerDiemCents: r.ircPerDiemCents,
    gipPerDiemCents: r.gipPerDiemCents,
    rhcLaborShare: r.laborShareRhc,
    chcLaborShare: r.laborShareChc,
    ircLaborShare: r.laborShareIrc,
    gipLaborShare: r.laborShareGip,
  };
}

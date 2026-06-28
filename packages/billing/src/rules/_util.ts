// @wardenx/billing — M23 §4.5 rule fan-out SHARED PURE HELPERS. Date arithmetic on ISO calendar dates
// is lexicographic (`YYYY-MM-DD` sorts == chronological), so every comparison below is a clock-free
// string compare — no `Date`, no timezone, no I/O. Election-/LOC-period coverage helpers are the common
// spine of the period/cert/f2f/loc rules. PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no clock.
import type { IsoDate } from "../contracts";
import type {
  ClaimSnapshot,
  ElectionPeriodSnapshot,
  LevelOfCarePeriodSnapshot,
} from "./types";

/** `a <= b` on ISO calendar dates (lexicographic == chronological for `YYYY-MM-DD`). */
export function dateLte(a: IsoDate, b: IsoDate): boolean {
  return a <= b;
}

/** `a < b` on ISO calendar dates. */
export function dateLt(a: IsoDate, b: IsoDate): boolean {
  return a < b;
}

/** True iff `date` ∈ [`from`, `to`] inclusive (ISO calendar dates). */
export function dateInRange(date: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return from <= date && date <= to;
}

/**
 * True iff a (possibly open-ended) election period overlaps the closed claim service window
 * [`from`, `to`]. An open period (`effectiveTo === null`) extends to `+∞`. For a REVOKED period the
 * effective coverage end is the revocation date (D5: a revoked patient's claim ends on revocation).
 */
export function periodOverlapsWindow(
  period: ElectionPeriodSnapshot,
  from: IsoDate,
  to: IsoDate,
): boolean {
  const end = effectivePeriodEnd(period);
  const startsBeforeOrOnWindowEnd = period.effectiveFrom <= to;
  const endsOnOrAfterWindowStart = end === null || end >= from;
  return startsBeforeOrOnWindowEnd && endsOnOrAfterWindowStart;
}

/** The effective coverage end of a period: the revocation date if revoked, else `effectiveTo` (open = null). */
export function effectivePeriodEnd(period: ElectionPeriodSnapshot): IsoDate | null {
  if (period.revoked && period.revocationDate !== null) return period.revocationDate;
  return period.effectiveTo;
}

/** True iff `date` is covered by `period` (using the revocation-aware effective end). */
export function periodCoversDate(period: ElectionPeriodSnapshot, date: IsoDate): boolean {
  if (date < period.effectiveFrom) return false;
  const end = effectivePeriodEnd(period);
  return end === null || date <= end;
}

/** Every election-period sequence whose effective coverage overlaps the claim's service window. */
export function periodsOverlappingClaim(
  claim: ClaimSnapshot,
  periods: readonly ElectionPeriodSnapshot[],
): readonly ElectionPeriodSnapshot[] {
  return periods.filter((p) => periodOverlapsWindow(p, claim.serviceFrom, claim.serviceTo));
}

/** The LOC period covering `date`, or `undefined` if none (a coverage gap the loc rule fails on). */
export function locPeriodCoveringDate(
  periods: readonly LevelOfCarePeriodSnapshot[],
  date: IsoDate,
): LevelOfCarePeriodSnapshot | undefined {
  return periods.find((p) => dateInRange(date, p.from, p.to));
}

/** Read a string-keyed default-parameter override, falling back to `fallback` when absent / wrong type. */
export function paramString(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string,
): string {
  const v = params[key];
  return typeof v === "string" ? v : fallback;
}

/** Read a numeric default-parameter override, falling back to `fallback` when absent / wrong type. */
export function paramNumber(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Read a `Record<LevelOfCare, string>` default-parameter override (e.g. the revenue-code-by-LOC map),
 * falling back to `fallback` when absent / malformed. Used by `level_of_care_coherence`.
 */
export function paramStringMap(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const v = params[key];
  if (v === null || typeof v !== "object") return fallback;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : fallback;
}

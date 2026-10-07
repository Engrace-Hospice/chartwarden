// apps/backend/src/modules/10-hope/jobs/retention.ts — the pure HOPE retention evaluator (GAP-181).
//
// WHAT THE ARCHITECTURE SAYS (architecture wins; the dispatching decision only filled silence):
//   - OPEN-021: clinical-record + HOPE retention is 7 years from last patient contact (HIPAA 45 CFR
//     164.316(b)(2) / 164.530(j) six-year documentation floor; 42 CFR 418.104 five years after discharge —
//     7 years is the longest of the three);
//   - M10 spec §3 retention class: submitted HOPE assessments keep the CMS `extended_for_cms` 10 years from
//     submission; unsubmitted drafts follow the standard 7-year compliance retention.
// A tenant/state override may only LENGTHEN either horizon. The evaluator never recommends destruction while a
// legal hold covers the patient, an iQIES submission item is still rejected / blocked / unmatched on a live
// assessment, or a correction draft is pending. It decides; it never deletes — destruction stays on the M4
// destruction-certificate pathway.

/** Standard HOPE retention (years from the last effective date) — architecture OPEN-021. */
export const HOPE_STANDARD_RETENTION_YEARS = 7;
/** Submitted-assessment retention (years from the last iQIES transmission) — CMS `extended_for_cms`. */
export const HOPE_SUBMITTED_RETENTION_YEARS = 10;

export type HopeRetentionBasis = "submitted_cms_10y" | "standard_7y";
export type HopeRetentionStatus = "eligible" | "blocked" | "cleared";
export type HopeRetentionBlocker = "legal_hold" | "open_iqies_error" | "pending_correction";

/** Everything the evaluator needs about one patient's HOPE record. */
export interface HopeRetentionFacts {
  readonly patientId: string;
  /** The latest signed / updated / target instant across the patient's HOPE assessments. */
  readonly lastEffectiveAt: Date;
  /** The latest iQIES transmission across the patient's submitted assessments (null = none submitted). */
  readonly lastTransmittedAt: Date | null;
  readonly openIqiesError: boolean;
  readonly pendingCorrection: boolean;
  readonly legalHold: boolean;
}

export interface HopeRetentionDecision {
  readonly basis: HopeRetentionBasis;
  readonly anchorAt: Date;
  readonly retentionYears: number;
  readonly eligibleAt: Date;
  readonly status: HopeRetentionStatus;
  readonly blockers: readonly HopeRetentionBlocker[];
}

/** `date` + `years` calendar years (UTC), clamping 29 Feb to 28 Feb in a non-leap target year. */
export function addYears(date: Date, years: number): Date {
  const d = new Date(date.getTime());
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  if (d.getUTCMonth() !== month) d.setUTCDate(0); // 29 Feb rolled into March
  return d;
}

/** A tenant/state override lengthens a horizon; anything shorter (or malformed) is ignored. */
export function effectiveYears(
  baseYears: number,
  overrideYears: number | null | undefined,
): number {
  if (typeof overrideYears !== "number" || !Number.isFinite(overrideYears)) return baseYears;
  return Math.max(baseYears, Math.ceil(overrideYears));
}

/**
 * The retention decision for one patient at `now`. A submitted record is held until the LATER of
 * `lastTransmittedAt + 10y` and `lastEffectiveAt + 7y` (a record never becomes eligible earlier than the
 * standard horizon just because it was submitted early).
 */
export function evaluateHopeRetention(
  facts: HopeRetentionFacts,
  now: Date,
  overrideYears?: number | null,
): HopeRetentionDecision {
  const standardYears = effectiveYears(HOPE_STANDARD_RETENTION_YEARS, overrideYears);
  const standardEligible = addYears(facts.lastEffectiveAt, standardYears);
  let basis: HopeRetentionBasis = "standard_7y";
  let anchorAt = facts.lastEffectiveAt;
  let retentionYears = standardYears;
  let eligibleAt = standardEligible;
  if (facts.lastTransmittedAt) {
    const submittedYears = effectiveYears(HOPE_SUBMITTED_RETENTION_YEARS, overrideYears);
    const submittedEligible = addYears(facts.lastTransmittedAt, submittedYears);
    if (submittedEligible.getTime() >= standardEligible.getTime()) {
      basis = "submitted_cms_10y";
      anchorAt = facts.lastTransmittedAt;
      retentionYears = submittedYears;
      eligibleAt = submittedEligible;
    }
  }
  if (now.getTime() < eligibleAt.getTime()) {
    return { basis, anchorAt, retentionYears, eligibleAt, status: "cleared", blockers: [] };
  }
  const blockers: HopeRetentionBlocker[] = [];
  if (facts.legalHold) blockers.push("legal_hold");
  if (facts.openIqiesError) blockers.push("open_iqies_error");
  if (facts.pendingCorrection) blockers.push("pending_correction");
  return {
    basis,
    anchorAt,
    retentionYears,
    eligibleAt,
    status: blockers.length > 0 ? "blocked" : "eligible",
    blockers,
  };
}

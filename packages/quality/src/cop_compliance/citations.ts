// @chartwarden/quality — M30 §7.7 / D10: the `cop_citation_v1` value set (the 23 Conditions-of-
// Participation citations the tenant self-assesses against, from architecture v0.11 §23.4 / §2.J).
//
// This is the PLATFORM-DEFINED canonical registry: a per-org `cop_compliance_status` row exists per
// citation (V-19 keys `cop_citation` against THIS set), and the surveyor-mode board (S-15) renders one
// card per row. The catalog carries the citation reference, human title, 42-CFR Part 418 subpart, and
// whether the citation is unconditionally `required` (the short-term-inpatient conditions §418.108 /
// .110 / .112 only apply to agencies that actually provide inpatient care — they are conditional, so a
// non-IPU tenant is not deficient for omitting them).
//
// PURE DOMAIN (P2a): a frozen const catalog + lookup/assert helpers + the `CopStatus` categorical
// posture helper. No DB, no I/O. V-19 validation (`assertCopCitation`) throws a `ChartWardenError` the
// route layer renders into the standard envelope in a LATER phase. The 23 rows themselves are also
// seeded into M38's `value_set` table by the migration (spec step 21) — this file is the in-process
// source of truth the domain logic resolves against.

/** The 42 CFR Part 418 subpart a CoP citation belongs to (B = eligibility/election, C = patient care, D = organizational environment). */
export type CopCitationSubpart = "B" | "C" | "D";

/** One platform-defined CoP citation row in the `cop_citation_v1` value set (§7.7, V-19). */
export interface CopCitationDef {
  /** The bare §418.xx citation number (e.g. `"418.58"`) — the `cop_compliance_status.cop_citation` key (V-19). */
  readonly citation: string;
  /** The fully-qualified regulatory reference (e.g. `"42 CFR §418.58"`). */
  readonly reference: string;
  /** Human-readable condition title (the surveyor-facing label on the S-15 card). */
  readonly title: string;
  /** The 42 CFR Part 418 subpart this condition lives under. */
  readonly subpart: CopCitationSubpart;
  /**
   * Whether the condition applies unconditionally. The short-term-inpatient conditions (§418.108 /
   * .110 / .112) are `false` — they only bind agencies that provide inpatient care, so a home-only
   * tenant carrying them as `not yet assessed` is NOT a survey deficiency.
   */
  readonly required: boolean;
}

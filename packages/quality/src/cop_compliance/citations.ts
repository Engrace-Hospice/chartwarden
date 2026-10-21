// @wardenx/quality — M30 §7.7 / D10: the `cop_citation_v1` value set (the 23 Conditions-of-
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
import { ChartWardenError } from "@wardenx/types";
import type { CopStatus } from "../contracts";

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

/**
 * The 23 CoP citations (the `cop_citation_v1` value set, architecture §23.4 condition-level rows). In
 * §418.xx ascending order: subpart B election/eligibility conditions, subpart C patient-care
 * conditions, subpart D organizational-environment conditions. The payment subparts (§418.3xx) are NOT
 * Conditions of Participation and are excluded from the self-assessment surface.
 */
export const COP_CITATION_V1: readonly CopCitationDef[] = [
  // Subpart B — eligibility, election, discharge.
  {
    citation: "418.22",
    reference: "42 CFR §418.22",
    title: "Certification of terminal illness",
    subpart: "B",
    required: true,
  },
  {
    citation: "418.24",
    reference: "42 CFR §418.24",
    title: "Election of hospice care; revocation",
    subpart: "B",
    required: true,
  },
  {
    citation: "418.25",
    reference: "42 CFR §418.25",
    title: "Admission to hospice care",
    subpart: "B",
    required: true,
  },
  {
    citation: "418.26",
    reference: "42 CFR §418.26",
    title: "Discharge from hospice care",
    subpart: "B",
    required: true,
  },
  {
    citation: "418.28",
    reference: "42 CFR §418.28",
    title: "Revocation; loss of eligibility; transfer",
    subpart: "B",
    required: true,
  },
  // Subpart C — patient care.
  {
    citation: "418.52",
    reference: "42 CFR §418.52",
    title: "Patient rights",
    subpart: "C",
    required: true,
  },
  {
    citation: "418.54",
    reference: "42 CFR §418.54",
    title: "Initial and comprehensive assessment of the patient",
    subpart: "C",
    required: true,
  },
  {
    citation: "418.56",
    reference: "42 CFR §418.56",
    title: "Interdisciplinary group, care planning, and coordination of services",
    subpart: "C",
    required: true,
  },
  {
    citation: "418.58",
    reference: "42 CFR §418.58",
    title: "Quality assessment and performance improvement (QAPI)",
    subpart: "C",
    required: true,
  },
  {
    citation: "418.60",
    reference: "42 CFR §418.60",
    title: "Infection control",
    subpart: "C",
    required: true,
  },
  {
    citation: "418.62",
    reference: "42 CFR §418.62",
    title: "Licensed professional services",
    subpart: "C",
    required: true,
  },
  {
    citation: "418.64",
    reference: "42 CFR §418.64",
    title: "Core services",
    subpart: "C",
    required: true,
  },
  {
    citation: "418.76",
    reference: "42 CFR §418.76",
    title: "Hospice aide and homemaker services",
    subpart: "C",
    required: true,
  },
  {
    citation: "418.78",
    reference: "42 CFR §418.78",
    title: "Volunteers",
    subpart: "C",
    required: true,
  },
  // Subpart D — organizational environment.
  {
    citation: "418.100",
    reference: "42 CFR §418.100",
    title: "Organization and administration of services",
    subpart: "D",
    required: true,
  },
  {
    citation: "418.102",
    reference: "42 CFR §418.102",
    title: "Medical director",
    subpart: "D",
    required: true,
  },
  {
    citation: "418.104",
    reference: "42 CFR §418.104",
    title: "Clinical records",
    subpart: "D",
    required: true,
  },
  {
    citation: "418.106",
    reference: "42 CFR §418.106",
    title: "Drugs, biologicals, medical supplies, and durable medical equipment",
    subpart: "D",
    required: true,
  },
  {
    citation: "418.108",
    reference: "42 CFR §418.108",
    title: "Short-term inpatient care",
    subpart: "D",
    required: false,
  },
  {
    citation: "418.110",
    reference: "42 CFR §418.110",
    title: "Hospices that provide inpatient care directly",
    subpart: "D",
    required: false,
  },
  {
    citation: "418.112",
    reference: "42 CFR §418.112",
    title: "Hospices that provide hospice care to residents of a SNF/NF or ICF/IID",
    subpart: "D",
    required: false,
  },
  {
    citation: "418.114",
    reference: "42 CFR §418.114",
    title: "Personnel qualifications",
    subpart: "D",
    required: true,
  },
  {
    citation: "418.116",
    reference: "42 CFR §418.116",
    title: "Compliance with Federal, State, and local laws and regulations",
    subpart: "D",
    required: true,
  },
] as const;

/** Fast index of the value set keyed by `citation` (e.g. `"418.58"`). */
const COP_CITATION_BY_ID: ReadonlyMap<string, CopCitationDef> = new Map(
  COP_CITATION_V1.map((c) => [c.citation, c] as const),
);

/** Every citation id in the `cop_citation_v1` value set, in §418.xx order. */
export const COP_CITATION_IDS: readonly string[] = COP_CITATION_V1.map((c) => c.citation);

/** The count of citations in the value set (23). A guard against accidental catalog drift. */
export const COP_CITATION_COUNT = COP_CITATION_V1.length;

/** True iff `citation` is a member of the `cop_citation_v1` value set (V-19). */
export function isCopCitation(citation: string): boolean {
  return COP_CITATION_BY_ID.has(citation);
}

/** Resolve a citation definition, or `undefined` if `citation` is not in the value set. */
export function getCopCitation(citation: string): CopCitationDef | undefined {
  return COP_CITATION_BY_ID.get(citation);
}

/**
 * Resolve a citation definition or throw (V-19). The route/seam layer (a LATER phase) lets the M1
 * error handler render the thrown `ChartWardenError` into the standard envelope.
 */
export function assertCopCitation(citation: string): CopCitationDef {
  const def = COP_CITATION_BY_ID.get(citation);
  if (def === undefined) {
    throw new ChartWardenError(
      "cop_citation_unknown",
      `'${citation}' is not a member of the cop_citation_v1 value set (V-19)`,
      422,
    );
  }
  return def;
}

/**
 * Categorical posture helper over the frozen `CopStatus` ladder (`compliant | at_risk | deficient`).
 * Returns `true` for the two postures that surface a citation on the risk register and the S-15
 * non-compliant cards — the same predicate `risk_register/refresh.ts` applies to `cop_compliance_status`.
 */
export function copStatusNeedsAttention(status: CopStatus): boolean {
  return status === "at_risk" || status === "deficient";
}

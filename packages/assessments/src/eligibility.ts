// @wardenx/assessments — discipline × scale eligibility matrix (§4.7 / D8, M9-T05). Pure, IO-free.
//
// D8: "which discipline may record which scale is a clinical-practice rule, not a configuration knob"
// (§ Design decisions). The matrix is a TYPED constant the recording boundary enforces via the
// `discipline_can_record_scale` ABAC predicate (M3 D5; registered by 09-assessments/abac-predicates.ts)
// AND the service re-checks defense-in-depth, raising §4.4 `DISCIPLINE_NOT_ELIGIBLE` (403). A discipline
// NOT in a scale's list cannot author it even under break-glass (§6 discipline-floor) — the data would be
// clinically meaningless. The spec gives the load-bearing examples (§ Design decisions D8):
//   • NYHA / MELD / BODE / Flacker — MD/NP-only (the prognostic instruments need physician expertise)
//   • PPS / KPS / FAST — RN + MD/NP (LPN allowed, but under the §7.4 supervisor cosign — cosignRequiredFor)
//   • Braden + Morse — any clinical role (deliberately broad so the field tablet captures them)
//   • AIMS — RN + MD/NP only (psych-trained roles); the Part 2 release is a READ gate, not a write gate
// the symptom instruments (ESAS-r / PAINAD / FLACC) and GDS follow §4.6's author defaults (MSW/Chaplain
// may record ESAS-r; CHHA records the broad-discipline risk/pain instruments).
import type { ScaleType } from "@wardenx/types";
import { SCALE_TYPES } from "@wardenx/types";

/** The clinical disciplines that can appear in `clinical_assessment.captured_by_discipline` (lower-case
 * keys the matrix compares; resolved from the actor's membership discipline / role tokens at the route). */
export const ASSESSMENT_DISCIPLINES = [
  "rn",
  "lpn",
  "chha",
  "md",
  "np",
  "msw",
  "chaplain",
  "volunteer",
] as const;

/** A discipline key the eligibility matrix is keyed on. */
export type AssessmentDiscipline = (typeof ASSESSMENT_DISCIPLINES)[number];

// Convenience discipline groupings (kept local — these are practice rules, not config).
const MD_NP = ["md", "np"] as const satisfies readonly AssessmentDiscipline[];
const RN_MD_NP_LPN = ["rn", "md", "np", "lpn"] as const satisfies readonly AssessmentDiscipline[];
const RN_MD_NP = ["rn", "md", "np"] as const satisfies readonly AssessmentDiscipline[];
const NURSING_BROAD = [
  "rn",
  "lpn",
  "chha",
  "md",
  "np",
] as const satisfies readonly AssessmentDiscipline[];

/**
 * D8 — the authoritative discipline × scale matrix. Each scale lists the disciplines that may RECORD it.
 * Type-checked across all 14 {@link ScaleType} keys (an off-matrix scale is a compile error). The matrix
 * is the same data the §4.7 `discipline_can_record_scale[:scaleType]` predicate and the service gate read.
 */
export const SCALE_DISCIPLINE_ELIGIBILITY: {
  readonly [K in ScaleType]: readonly AssessmentDiscipline[];
} = {
  // Performance / prognostic — physician-expertise instruments are MD/NP-only.
  pps: RN_MD_NP_LPN, // LPN allowed under §7.4 supervisor cosign
  kps: RN_MD_NP_LPN, // LPN allowed under §7.4 supervisor cosign
  nyha: MD_NP,
  meld: MD_NP,
  bode: MD_NP,
  flacker: MD_NP,
  // Symptom instruments — broad clinical capture; MSW/Chaplain may record ESAS-r (§4.6 author defaults).
  esas_r: ["rn", "lpn", "md", "np", "msw", "chaplain"],
  painad: NURSING_BROAD,
  flacc: NURSING_BROAD,
  // Risk instruments — deliberately any-clinical-role (the pressure-injury / fall-risk field captures).
  braden: NURSING_BROAD,
  morse: NURSING_BROAD,
  // Cognitive / staging / movement.
  fast: RN_MD_NP_LPN, // LPN allowed under §7.4 supervisor cosign
  gds: ["rn", "msw", "md", "np"],
  aims: RN_MD_NP, // psych-trained roles only
};

/** Normalize a free-text discipline (the `captured_by_discipline` column / a role token) to a matrix key. */
function disciplineKey(discipline: string): string {
  return discipline.trim().toLowerCase();
}

/**
 * §4.7 / D8 — whether `discipline` may record `scaleType`. Pure membership over the typed matrix; the
 * recording service raises `DISCIPLINE_NOT_ELIGIBLE` (403) when this is false, and the ABAC predicate
 * denies the route. Returns false for an unknown discipline string (fail-closed).
 */
export function disciplineCanRecordScale(discipline: string, scaleType: ScaleType): boolean {
  const key = disciplineKey(discipline);
  return (SCALE_DISCIPLINE_ELIGIBILITY[scaleType] as readonly string[]).includes(key);
}

/**
 * §4.7 / D8 — whether ANY of the caller's disciplines may record `scaleType` (the predicate evaluates the
 * actor's full discipline set; an actor with several memberships qualifies if one discipline is eligible).
 */
export function anyDisciplineCanRecordScale(
  disciplines: readonly string[],
  scaleType: ScaleType,
): boolean {
  return disciplines.some((d) => disciplineCanRecordScale(d, scaleType));
}

/** The full set of scales a discipline may record (the picker filter, §5 record-modal step 1). */
export function scalesRecordableBy(discipline: string): readonly ScaleType[] {
  return SCALE_TYPES.filter((s) => disciplineCanRecordScale(discipline, s));
}

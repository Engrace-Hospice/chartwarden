// @chartwarden/hope — the required-items-per-RFA matrix (M10-T04; §2.3, §3, CMS HOPE submission spec). PURE
// data: which HOPE Section letters every Reason-For-Assessment must carry for the CMS pre-submission
// "required items" rule. The recording-boundary TypeBox (M10-T06) composes its discriminated union from
// this matrix; the pre-submission validator (`../validation/validate-hope-assessment.ts`) diffs the
// present sections against it and writes a `hope_validation_finding` per missing required section.
//
// Section Q (Participation) is intentionally NOT listed for the Discharge RFA here: its presence is
// conditional on the discharge reason (death omits Q; every live branch requires it) and is enforced by
// the dedicated §2.3 / D9 cross-field rule, not the flat per-RFA matrix.
import { HOPE_RFA_KINDS, type HopeRfaKind } from "@chartwarden/types";

/** Every HOPE Section letter the engine recognises (the §2.1 A–Z section roster; L/P/R/S/T/U/V/W/Y are
 * not part of the CMS HOPE instrument and are intentionally absent). */
export const HOPE_SECTION_LETTERS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "M",
  "N",
  "O",
  "Q",
  "X",
  "Z",
] as const;

/** One HOPE Section letter (§2.1). */
export type HopeSectionLetter = (typeof HOPE_SECTION_LETTERS)[number];

// The full comprehensive section set the comprehensive (Admission / HUV1 / HUV2) timepoints must carry.
const COMPREHENSIVE_SECTIONS: readonly HopeSectionLetter[] = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "M",
  "N",
  "O",
  "Q",
  "X",
  "Z",
];

/**
 * §2.3 / §3 — required Section letters per RFA (the CMS HOPE submission "required items" matrix).
 *   - `01_admission` / `02_huv1` / `03_huv2` — the comprehensive instrument (all A–Z sections except the
 *     CMS-unused letters).
 *   - `04_sfv` — the focused Symptom-Follow-Up Visit carries only the administrative + symptom sections
 *     (A, J, Z); it re-screens J2051 and documents the follow-up, not the whole instrument.
 *   - `05_discharge` — the discharge instrument carries A, I, J, X, Z; Section Q is conditional on the
 *     discharge reason (D9) and is enforced by the dedicated cross-field rule, NOT this flat list.
 */
export const REQUIRED_SECTIONS_BY_RFA: {
  readonly [K in HopeRfaKind]: readonly HopeSectionLetter[];
} = {
  "01_admission": COMPREHENSIVE_SECTIONS,
  "02_huv1": COMPREHENSIVE_SECTIONS,
  "03_huv2": COMPREHENSIVE_SECTIONS,
  "04_sfv": ["A", "J", "Z"],
  "05_discharge": ["A", "I", "J", "X", "Z"],
};

/** The required Section letters for `rfaKind` that are MISSING from `presentSections`, in matrix order. */
export function missingRequiredSections(
  rfaKind: HopeRfaKind,
  presentSections: readonly string[],
): readonly HopeSectionLetter[] {
  const present = new Set(presentSections);
  return REQUIRED_SECTIONS_BY_RFA[rfaKind].filter((s) => !present.has(s));
}

// Compile-time exhaustiveness: every HopeRfaKind has a matrix entry.
const _matrixCoversEveryRfa: readonly HopeRfaKind[] = HOPE_RFA_KINDS.filter(
  (k) => REQUIRED_SECTIONS_BY_RFA[k] !== undefined,
);
void _matrixCoversEveryRfa;

// @chartwarden/billing — ONE canonical discipline code. M8 stores `encounter_discipline` as lowercase enum values
// (`rn`, `msw`, ...). Three callers used to normalise it privately (the SIA calculator upper-cased, the visit-code
// table lower-cased, the `sia_calculation_correct` rule compared raw against `"RN"`), and the rule silently
// failed every real claim. Normalise here, at the shared boundary, and compare canonical values everywhere.
// PURE: no I/O.

/** The M8 `encounter_discipline` enum values (lockstep-tested against `packages/db/src/enums.ts`). */
export const CANONICAL_DISCIPLINES = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "volunteer",
  "md",
  "np",
  "pt",
  "ot",
  "slp",
] as const;

export type CanonicalDiscipline = (typeof CANONICAL_DISCIPLINES)[number];

/** Spellings other systems use for a canonical discipline (case-insensitive). */
const DISCIPLINE_ALIASES: Readonly<Record<string, CanonicalDiscipline>> = {
  hha: "chha",
};

/**
 * The canonical discipline for `raw`, or `null` when it is not a known discipline. Never guesses: an unknown
 * code is surfaced by the caller, not coerced into an eligible one.
 */
export function normalizeDiscipline(raw: string): CanonicalDiscipline | null {
  const key = raw.trim().toLowerCase();
  const aliased = DISCIPLINE_ALIASES[key] ?? key;
  return (CANONICAL_DISCIPLINES as readonly string[]).includes(aliased)
    ? (aliased as CanonicalDiscipline)
    : null;
}

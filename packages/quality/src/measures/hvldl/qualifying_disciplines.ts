// @chartwarden/quality — HVLDL qualifying-discipline constants (§1.1, D3). Pure data.
//
// HVLDL counts visits by a QUALIFYING discipline in the last three days of life. CMS FY2025 qualifies RN
// and MSW; the FY2028-projected expansion (Chaplain, Aide) is wired as a CONSTANT change now, not a code
// change later (D3) — the calculator reads whichever list the worker passes for the reporting FY.

/** A care discipline that may qualify for the HVLDL last-days-of-life visit predicate. */
export type HvldlDiscipline = "rn" | "msw" | "chaplain" | "aide";

/** FY2025 qualifying disciplines per the CMS HVLDL technical specification. */
export const HVLDL_QUALIFYING_DISCIPLINES_v2025: readonly HvldlDiscipline[] = [
  "rn",
  "msw",
] as const;

/** FY2028-projected qualifying disciplines (CMS-signaled expansion; constant-only change per D3). */
export const HVLDL_QUALIFYING_DISCIPLINES_v2028: readonly HvldlDiscipline[] = [
  "rn",
  "msw",
  "chaplain",
  "aide",
] as const;

/** The CMS minimum qualifying-discipline visit count in the last days of life (≥ 2 per spec). */
export const HVLDL_MIN_QUALIFYING_VISITS = 2;

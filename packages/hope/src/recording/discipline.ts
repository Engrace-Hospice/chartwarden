// @chartwarden/hope — the HOPE author-discipline rule (M10-T03; §2.3, §4.7, the "RN/NP-only author rule").
// PURE, IO-free. CMS HOPE manual restricts WHO may complete a HOPE assessment, and restricts the SFV
// author further:
//   • Any HOPE timepoint (Admission / HUV1 / HUV2 / Discharge) → discipline ∈ {RN, NP, MD}
//     (§4.7 `hope.authorDisciplineAllowed`).
//   • A Symptom-Follow-Up-Visit (RFA 04)                       → discipline ∈ {RN, NP, LPN, LVN}
//     (§4.7 `hope.sfvAuthorAllowed`). CMS HOPE Guidance Manual v1.03 (eff. 2026-10-01) lets an LPN/LVN
//     conduct and complete an SFV when the hospice determines that discipline appropriate; the hospice's
//     determination is agency policy and is not modelled here. CMS does not extend this to other
//     disciplines, so MD and all others stay excluded.
// These are the data backing the M3 ABAC predicates registered in M10-T06; the route binds them via
// `requireAbac`, and the recording service calls the `assert*` guards as defense in depth (the §9.3
// authorization-independence requirement: a discipline-elevation attempt is denied at the service even if
// a route check is bypassed). The acting discipline is resolved from M40's `mdm.discipline_taxonomy`
// (injected as a plain string fact — M10 never imports M40 schema).
import type { HopeRfaKind } from "@chartwarden/types";
import { require_ } from "../errors";

/** §4.7 — disciplines permitted to author any HOPE timepoint (CMS HOPE manual). */
export const HOPE_AUTHOR_DISCIPLINES = ["RN", "NP", "MD"] as const;

/** §4.7 — disciplines permitted to author a Symptom-Follow-Up-Visit (CMS HOPE Guidance Manual v1.03). */
export const SFV_AUTHOR_DISCIPLINES = ["RN", "NP", "LPN", "LVN"] as const;

/** A discipline code the acting clinician carries (M40 `mdm.discipline_taxonomy`; opaque to M10). */
export type DisciplineCode = string;

/** §4.7 `hope.authorDisciplineAllowed` — may this discipline author a (non-SFV) HOPE timepoint? */
export function isHopeAuthorDisciplineAllowed(discipline: DisciplineCode): boolean {
  return (HOPE_AUTHOR_DISCIPLINES as readonly string[]).includes(discipline);
}

/** §4.7 `hope.sfvAuthorAllowed` — may this discipline author a Symptom-Follow-Up-Visit (RFA 04)? */
export function isSfvAuthorDisciplineAllowed(discipline: DisciplineCode): boolean {
  return (SFV_AUTHOR_DISCIPLINES as readonly string[]).includes(discipline);
}

/**
 * §2.3 / §4.7 — guard the recording path on the author's discipline, branching on `rfa_kind`: an SFV
 * (RFA 04) requires RN/NP/LPN/LVN; every other RFA requires RN/NP/MD. Raises `M10_DISCIPLINE_NOT_PERMITTED`
 * (403). This is the service-layer enforcement behind the M3 ABAC predicate (defense in depth).
 */
export function assertAuthorDisciplineAllowed(
  rfaKind: HopeRfaKind,
  discipline: DisciplineCode,
): void {
  const allowed =
    rfaKind === "04_sfv"
      ? isSfvAuthorDisciplineAllowed(discipline)
      : isHopeAuthorDisciplineAllowed(discipline);
  require_(
    allowed,
    "M10_DISCIPLINE_NOT_PERMITTED",
    rfaKind === "04_sfv"
      ? `Discipline '${discipline}' may not author a Symptom-Follow-Up-Visit (RN/NP/LPN/LVN only).`
      : `Discipline '${discipline}' may not author a HOPE assessment (RN/NP/MD only).`,
  );
}

// apps/backend/src/modules/06-admission/certification/f2f-performer.ts — GAP-022 (42 CFR 418.22 / R-F2F-01).
//
// The F2F performer's role is a SERVER-DERIVED fact: it comes from the scheduled clinician's real
// (enabled, unexpired) role grants, never from the request body. The body's `clinicianRole` is only a
// CLAIM that must be backed by a grant. Spec (§2.3.4 R-F2F-01, `performer_role IN ('hospice_md',
// 'hospice_np')`) lists no PA and no RN: an RN / RN case manager can never perform or attest the F2F.
import { AdmissionStateError } from "../state-machines/errors";

export type F2fPerformerRole = "hospice_md" | "hospice_np";

/** Role keys that make a clinician a hospice physician performer (the `hospice_md` side). */
export const F2F_MD_ROLE_KEYS: ReadonlySet<string> = new Set([
  "md",
  "hospice_physician",
  "medical_director",
]);
/** Role keys that make a clinician a hospice NP performer. */
export const F2F_NP_ROLE_KEYS: ReadonlySet<string> = new Set(["np"]);
/** Every role key the §4.6 `f2f.is_hospice_md_or_np` predicate admits (no RN, no PA). */
export const F2F_PERFORMER_ROLE_KEYS: readonly string[] = [
  ...F2F_MD_ROLE_KEYS,
  ...F2F_NP_ROLE_KEYS,
];

const invalid = (message: string): AdmissionStateError =>
  new AdmissionStateError("F2F_INVALID_PERFORMER", message);

/**
 * Resolve the stored `performer_role` from the clinician's role keys. `null` = no live membership for
 * that user in this org. `claimed` (the request body's value) must be held; absent, MD wins when both
 * are held. Throws `F2F_INVALID_PERFORMER` (422) otherwise.
 */
export function resolveF2fPerformerRole(
  roleKeys: readonly string[] | null,
  claimed: string | undefined,
): F2fPerformerRole {
  if (roleKeys === null) throw invalid("the scheduled clinician has no active membership");
  const isMd = roleKeys.some((k) => F2F_MD_ROLE_KEYS.has(k));
  const isNp = roleKeys.some((k) => F2F_NP_ROLE_KEYS.has(k));
  if (claimed !== undefined && claimed !== "hospice_md" && claimed !== "hospice_np")
    throw invalid("F2F performer must be a hospice MD or NP");
  if (claimed === "hospice_md" && !isMd)
    throw invalid("the scheduled clinician does not hold a hospice physician role");
  if (claimed === "hospice_np" && !isNp)
    throw invalid("the scheduled clinician does not hold the NP role");
  if (claimed !== undefined) return claimed;
  if (isMd) return "hospice_md";
  if (isNp) return "hospice_np";
  throw invalid("F2F performer must be a hospice MD or NP");
}

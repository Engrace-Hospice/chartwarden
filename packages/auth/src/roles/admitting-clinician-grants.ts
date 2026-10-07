// The DEFAULT grants that let the nursing, physician, NP and PA roles open admissions — a brand-new admission or a
// readmission — wherever a tenant has created those roles. Before this, only `intake_supervisor` (INTAKE_DEFAULT_GRANTS)
// and the admin roles could, so a nurse or doctor who admits the patient at the bedside had no way in.
//
//   • `admission.create` — `POST /api/v1/admissions` (new admission or readmission).
//   • `admission.read`   — the benefit-period plan reads behind the New admission / Readmit screens.
//   • `billing.eligibility.read` — the HETS benefit-period history panel. READ ONLY: forcing a live HETS check
//     (`billing.eligibility.check`) stays a billing action.
//
// RBAC is only half of it. WHICH patients a holder may admit is the M6 `admission_clinical_site_scope` ABAC predicate
// (the caller's own provider entity / location), composed beside `caseload_or_scope` and `admission_intake_scope` on
// exactly the new-admission / readmission routes. That predicate keys off ADMITTING_CLINICIAN_ROLE_KEYS below, so the
// grant list and the scope rule cannot drift apart.
//
// The keys are the repo's clinical role-key convention (seed-staff-personas.ts personas: rn, rn_case_manager, lpn,
// md, hospice_physician, medical_director, np; templates.ts: director_of_nursing) plus the synonyms tenants create
// (physician, nurse_practitioner, attending_clinician, pa). External roles — `physician_office` and every
// portal/collaborator role — are deliberately absent.
//
// NOT a `system_locked` floor: a tenant may remove a key from a role it owns. This is the single source the backfill
// migration `0379` and the dev-seed grant are pinned to — `m6-readmission.live.test.ts` compares migration and
// constant (the INTAKE_DEFAULT_GRANTS / `0374` precedent).

const ADMITTING_KEYS = ["admission.create", "admission.read", "billing.eligibility.read"] as const;

/** The clinical (non-intake) role keys that may open an admission at their own site. */
export const ADMITTING_CLINICIAN_ROLE_KEYS = [
  "rn",
  "lpn",
  "rn_case_manager",
  "director_of_nursing",
  "md",
  "physician",
  "hospice_physician",
  "medical_director",
  "attending_clinician",
  "np",
  "nurse_practitioner",
  "pa",
] as const;

export type AdmittingClinicianRoleKey = (typeof ADMITTING_CLINICIAN_ROLE_KEYS)[number];

export const ADMITTING_CLINICIAN_DEFAULT_GRANTS: Readonly<
  Record<AdmittingClinicianRoleKey, readonly string[]>
> = Object.freeze({
  rn: ADMITTING_KEYS,
  lpn: ADMITTING_KEYS,
  rn_case_manager: ADMITTING_KEYS,
  director_of_nursing: ADMITTING_KEYS,
  md: ADMITTING_KEYS,
  physician: ADMITTING_KEYS,
  hospice_physician: ADMITTING_KEYS,
  medical_director: ADMITTING_KEYS,
  attending_clinician: ADMITTING_KEYS,
  np: ADMITTING_KEYS,
  nurse_practitioner: ADMITTING_KEYS,
  pa: ADMITTING_KEYS,
});

/** Does this role set include an admitting clinician role? (server-assembled `context.roles` only). */
export function hasAdmittingClinicianRole(roles: readonly string[]): boolean {
  return ADMITTING_CLINICIAN_ROLE_KEYS.some((role) => roles.includes(role));
}

// The role keys that may set a patient's code status (`patient.edit_code_status`, ADR-0104): physicians, NPs, the
// nurse case-manager, the DON and the administrators — wherever a tenant has created those roles (nothing
// materializes ROLE_TEMPLATES). Intake and other roles are deliberately absent. NOT a `system_locked` floor.
// The single source migration `1294` is pinned to.
export const CODE_STATUS_EDITOR_ROLE_KEYS = [
  "rn_case_manager",
  "director_of_nursing",
  "md",
  "physician",
  "hospice_physician",
  "medical_director",
  "attending_clinician",
  "np",
  "nurse_practitioner",
  "administrator",
  "org_admin",
] as const;

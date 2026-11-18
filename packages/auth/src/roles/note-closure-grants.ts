// The role keys that hold the visit-note closure permissions by default (`encounter.closure_override` and
// `encounter.closure_policy_admin`, ADR-0113): the four supervisor keys migration 1103 already uses for the review queue
// (`clinical_supervisor`, the canonical DON `director_of_nursing` and its legacy alias `don`, and `clinical_lead`), wherever a
// tenant has created those roles (nothing materializes ROLE_TEMPLATES). Never org_admin, aides, volunteers or compliance roles;
// a tenant tightens by removing the grant from a role it owns. The single source migration `1511` is pinned to. NOT a
// `system_locked` floor.
export const NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS = [
  "clinical_supervisor",
  "director_of_nursing",
  "don",
  "clinical_lead",
] as const;

/** The two permission keys migration 1511 mirrors into the catalog and grants to {@link NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS}. */
export const NOTE_CLOSURE_PERMISSION_KEYS = [
  "encounter.closure_override",
  "encounter.closure_policy_admin",
] as const;

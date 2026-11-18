// The role keys that hold the visit-note closure permissions by default (`encounter.closure_override` and
// `encounter.closure_policy_admin`, ADR-0113): the four supervisor keys migration 1103 already uses for the review queue
// (`clinical_supervisor`, the canonical DON `director_of_nursing` and its legacy alias `don`, and `clinical_lead`).
// Two paths deliver them, both pinned to this file:
//   - an existing tenant: migration `1511` grants the keys to whichever of those roles the tenant already created;
//   - a tenant provisioned later: the GAP-006 materializer builds roles from ROLE_TEMPLATES, and only `director_of_nursing` is a
//     template, so templates.ts spreads NOTE_CLOSURE_DEFAULT_GRANTS into it (clinical_supervisor / don / clinical_lead are not
//     templates; a role created by hand after migration 1511 receives nothing, as with the care plan and code-status grants).
// Never org_admin / administrator (both keys are in FULL_CATALOG_EXCLUDED_KEYS: the obligated supervisors, not the tenant admin,
// release a blocked clinician), aides, volunteers or compliance roles; a tenant tightens by removing the grant from a role it
// owns. NOT a `system_locked` floor.
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

/** Role key -> the closure keys it holds by default; the DON template (templates.ts) and migration `1511` are pinned to it. */
export const NOTE_CLOSURE_DEFAULT_GRANTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS.map((roleKey) => [roleKey, NOTE_CLOSURE_PERMISSION_KEYS]),
    ),
  );

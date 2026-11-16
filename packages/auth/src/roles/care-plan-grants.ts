// The DEFAULT `care_plan.*` grants for the clinical roles (Workflow 06, D-2, control CW-AC-44). Before this only the
// administrators held them (and the DON held `finalize`), so a tenant's nurse case manager could neither open the plan
// nor author or sign it until an administrator granted each key by hand.
//
//   • read / read_summary — every clinical role that works from the plan. RBAC only: WHICH patient is the
//     `caseload_or_scope` / `collaborator_or_caseload` ABAC predicate, and Part 2 content is redacted per caller.
//   • author / finalize   — the nurse case manager, the clinical supervisor and the DON. `author` is also gated per
//     discipline by `discipline_scope`.
//   • sign                — EXACTLY the six signer roles: `signer_role_match` (abac-predicates.ts SIGNER_ROLE_KEYS)
//     matches the caller's role KEYS against the version's required signer set, so a grant to any other key could
//     never sign anyway.
//
// NOT granted: `care_plan.bootstrap` (system/admin, on admission activation) and `care_plan.idg_revise` (the outbox
// consumer). External, portal and collaborator roles are deliberately absent.
//
// NOT a `system_locked` floor: a tenant may remove a key from a role it owns.
//
// COVERAGE, which is narrower than the table above reads:
//   • Existing tenants — migration `1494` grants the keys to whichever of these roles each tenant already has.
//   • New tenants — the GAP-006 materializer creates only the ROLE_TEMPLATES, and only `director_of_nursing` and
//     `medical_director` are templates (templates.ts carries their keys). `rn_case_manager`, `hospice_physician`,
//     `nurse_practitioner`, `msw`, `chaplain` and the read-only clinical roles are NOT templates, so a new tenant has
//     no signer role that can sign until an administrator creates those roles and grants the keys.
//   • A role created after migration 1494 receives nothing, as with the admitting-clinician and code-status grants.
// This is the single source migration `1494` and the DON / Medical Director templates are pinned to
// (`care-plan-grants.test.ts`); the sign list is pinned to the predicate's own (`care-plan-grants-pin.test.ts`).

const READ_KEYS = ["care_plan.read", "care_plan.read_summary"] as const;
const AUTHOR_KEYS = [...READ_KEYS, "care_plan.author", "care_plan.finalize"] as const;
const SIGN_KEYS = [...READ_KEYS, "care_plan.sign"] as const;

/** Role key → the `care_plan.*` keys it holds by default. */
export const CARE_PLAN_DEFAULT_GRANTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  rn: READ_KEYS,
  lpn: READ_KEYS,
  lvn: READ_KEYS,
  md: READ_KEYS,
  physician: READ_KEYS,
  medical_director: SIGN_KEYS,
  attending_clinician: READ_KEYS,
  np: READ_KEYS,
  pa: READ_KEYS,
  idg_coordinator: READ_KEYS,
  hospice_physician: SIGN_KEYS,
  nurse_practitioner: SIGN_KEYS,
  msw: SIGN_KEYS,
  chaplain: SIGN_KEYS,
  rn_case_manager: [...AUTHOR_KEYS, "care_plan.sign"],
  clinical_supervisor: AUTHOR_KEYS,
  director_of_nursing: AUTHOR_KEYS,
});

/** The role keys that hold at least one default `care_plan.*` grant. */
export const CARE_PLAN_GRANTEE_ROLE_KEYS = Object.keys(CARE_PLAN_DEFAULT_GRANTS);

// Who holds the visit-note closure permissions by default (ADR-0113). Two keys, two different owners:
//
//   encounter.closure_override       lifting a blocked clinician's block for up to 24 hours. The four supervisor role keys migration
//                                    1103 already uses for the review queue (`clinical_supervisor`, the canonical DON
//                                    `director_of_nursing` and its legacy alias `don`, and `clinical_lead`): the people who answer for
//                                    the documentation duty. NEVER org_admin / administrator / superadmin (an administrator is not a
//                                    clinical supervisor): the key is in FULL_CATALOG_EXCLUDED_KEYS.
//   encounter.closure_policy_admin   setting the tenant's closure mode (off | warn | block) and threshold. The director of nursing
//                                    (`director_of_nursing`, `don`) AND the tenant administrators (`org_admin`, `administrator`, and
//                                    `superadmin` through the full-catalog rule). NOT `clinical_supervisor` or `clinical_lead`: the
//                                    policy is set by the tenant-level owners, not by the field supervisors. (The DON is bound by the
//                                    clock like any supervisor and still holds it: deliberate, guarded by step-up and an audit event.)
//
// Three paths deliver them, all pinned to this file:
//   - an existing tenant: migration `1511` grants the keys to whichever of those roles the tenant already created (and the policy key
//     to its existing org_admin / administrator roles, the way earlier migrations grant a new catalog key);
//   - a tenant provisioned later: the GAP-006 materializer builds roles from ROLE_TEMPLATES. Only `director_of_nursing` is a template,
//     so templates.ts spreads NOTE_CLOSURE_DEFAULT_GRANTS into it; org_admin / administrator derive the policy key from the full catalog
//     (clinical_supervisor / don / clinical_lead are not templates; a role created by hand after migration 1511 receives nothing, as
//     with the care plan and code-status grants);
//   - the dev permission sync and the two dev seeds (scripts/db/sync-permission-catalog.ts, seed.ts, seed-org-admin.ts), which apply
//     the same exclusion through scripts/db/lib/full-catalog-grants.ts (pinned by scripts/__tests__/full-catalog-grants.test.ts).
// Aides, volunteers and compliance roles hold neither key. A tenant tightens by removing a grant from a role it owns. NOT a
// `system_locked` floor.

/** The four role keys that hold `encounter.closure_override` by default (migration 1511, the DON template). */
export const NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS = [
  "clinical_supervisor",
  "director_of_nursing",
  "don",
  "clinical_lead",
] as const;

/** The two supervisor role keys that also hold `encounter.closure_policy_admin` by default; the administrators derive it elsewhere. */
export const NOTE_CLOSURE_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS = [
  "director_of_nursing",
  "don",
] as const;

/** The two permission keys migration 1511 mirrors into the catalog. */
export const NOTE_CLOSURE_PERMISSION_KEYS = [
  "encounter.closure_override",
  "encounter.closure_policy_admin",
] as const;

const [OVERRIDE_KEY, POLICY_ADMIN_KEY] = NOTE_CLOSURE_PERMISSION_KEYS;
const POLICY_ADMIN_SUPERVISORS: readonly string[] = NOTE_CLOSURE_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS;

/**
 * Role key -> the closure keys it holds by default among the supervisor roles: the override for all four, the policy key for the DON
 * keys only. The DON template (templates.ts) and migration `1511` are pinned to it.
 */
export const NOTE_CLOSURE_DEFAULT_GRANTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS.map((roleKey) => [
        roleKey,
        POLICY_ADMIN_SUPERVISORS.includes(roleKey)
          ? [OVERRIDE_KEY, POLICY_ADMIN_KEY]
          : [OVERRIDE_KEY],
      ]),
    ),
  );

// Who holds the visit-note draft switch by default (ADR-0114 VN-D17). One key, the SAME owners as `encounter.closure_policy_admin`
// (note-closure-grants.ts): the tenant-level owners, not the field supervisors.
//
//   encounter.draft_policy_admin   switching the tenant's deterministic visit-note draft (and its sign gate) on or off. The director of
//                                  nursing (`director_of_nursing`, `don`) AND the tenant administrators (`org_admin`, `administrator`,
//                                  and `superadmin` through the full-catalog rule). NOT `clinical_supervisor` or `clinical_lead`.
//
// Three paths deliver it, all pinned to this file (apps/backend/__tests__/visit-note-draft-grants.test.ts):
//   - an existing tenant: migration `1520` grants the key to whichever of those roles the tenant already created;
//   - a tenant provisioned later: the GAP-006 materializer builds roles from ROLE_TEMPLATES. Only `director_of_nursing` is a template,
//     so templates.ts spreads VISIT_NOTE_DRAFT_DEFAULT_GRANTS into it; org_admin / administrator derive the key from the full catalog;
//   - the dev permission sync and the two dev seeds, through scripts/db/lib/idg-role-grants.ts (the category sweep would otherwise
//     hand a `compliance`-category key to the auditor and every field persona).
// Aides, volunteers and compliance roles hold nothing here. A tenant tightens by removing a grant from a role it owns.

/** The permission key migration 1520 mirrors into the catalog. */
export const DRAFT_POLICY_ADMIN_PERMISSION_KEY = "encounter.draft_policy_admin" as const;

/** The supervisor role keys that hold the draft switch by default; the administrators derive it from the full catalog. */
export const DRAFT_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS = ["director_of_nursing", "don"] as const;

/** Role key -> the draft key it holds by default among the supervisor roles. The DON template (templates.ts) and migration `1520` are pinned to it. */
export const VISIT_NOTE_DRAFT_DEFAULT_GRANTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      DRAFT_POLICY_ADMIN_SUPERVISOR_ROLE_KEYS.map((roleKey) => [
        roleKey,
        [DRAFT_POLICY_ADMIN_PERMISSION_KEY],
      ]),
    ),
  );

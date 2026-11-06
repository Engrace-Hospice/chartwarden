// @chartwarden/auth · roles — keys the SYSTEM owns inside a tenant org (slice 2, the staff meter's auditor rule).
//
// `external_auditor` is the one role the platform creates INSIDE a tenant's org: M3's auditor grant (auditor-access-grant.ts) makes it
// on the first magic-link redemption, as an org-owned row with `system_default = true` and category `external_auditor`, and then
// attaches every auditor to it. Two things rest on that being THE row: an auditor holds exactly the auditor minimum, and the staff
// meter does not bill a membership whose every grant is that system role. A tenant that could create its own role under the same key
// (a tenant-written row is never `system_default`) would get a look-alike that the grant finds by key and attaches a real auditor to
// (so the auditor lands on a tenant-editable role), and a role it could attach to staff to try to hide them from the bill.
//
// So a tenant may not create a role under a system-managed key (M3 `POST /api/v1/roles` answers 422 RESERVED_ROLE, and the database
// backstop, migration 1365, refuses it for any writer), and the auditor grant refuses to adopt a row of that key that is not the
// system one. The list is deliberately the keys the system CREATES in a tenant org on demand; the platform keys have their own
// reservation (./platform-reserved) and the CoP / org-wide-scope keys are materialized from the templates at provisioning.

/** The role M3's auditor grant creates in a tenant org. */
export const EXTERNAL_AUDITOR_ROLE_KEY = "external_auditor";

/** Role keys the system creates inside a tenant org; a tenant may not create a role under one. */
export const SYSTEM_MANAGED_ROLE_KEYS: readonly string[] = [EXTERNAL_AUDITOR_ROLE_KEY];

/** True when `key` is one the system owns inside a tenant org (a tenant-created role may not carry it). */
export function isSystemManagedRoleKey(key: string): boolean {
  return SYSTEM_MANAGED_ROLE_KEYS.includes(key);
}

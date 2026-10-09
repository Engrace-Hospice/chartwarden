// The DEFAULT grants for the two SSN permissions (GAP-010; M5 spec §4.7), wherever a tenant has created the roles.
//
//   • `phi.write_ssn` — store an SSN / state id on a chart (admit with an SSN; `POST /patients/:id/identifiers`).
//   • `phi.read_ssn`  — reveal the full value (`POST /patients/:id/identifiers/:identifierId/reveal`). The masked
//     last-4 on the identifiers tab needs neither key.
//
// Before this, no role template and no grant migration named either key, so the whole SSN path was unreachable
// for everyone but a wildcard role. The M5 spec §4.7 names "Billing roles, Admissions Nurse, org_admin" for the write
// and adds the Compliance Officer for the read; the role KEYS in this repo are not those display names:
//
//   • `intake_supervisor`  — the admissions role (INTAKE_ROLE_KEYS; M6 spec §6). There is no "admissions nurse" key:
//                            the clinicians who admit at the bedside (`rn`, `np`, …) are DELIBERATELY not granted
//                            either key — minimum necessary (45 CFR 164.514(d)); they never need a full SSN.
//   • `billing_manager`    — the M23 billing role (`claim_in_billing_manager_caseload`). `billing_finance` is only a
//                            role CATEGORY in templates.ts, not a role key, so it cannot be granted to.
//   • `org_admin`, `administrator` — the two FULL_CATALOG template roles (template-materialization.ts). New orgs
//                            already receive every catalog key on them; this list is what backfills EXISTING orgs.
//   • `compliance_officer` — read only (reveal for investigation / disclosure accounting).
//
// SCOPE NOTE. Both keys declare `abac: "caseload_or_scope"`, and the write/reveal routes compose the REAL chart-scope
// predicate (a refusal is a 404). `compliance_officer` is an org-wide-scope role (org-wide-scope.ts); `intake_supervisor`,
// `billing_manager`, `org_admin` and `administrator` are NOT, so for them reveal / identifier-edit reaches the charts
// they hold an assignment on, while the ADMIT-time SSN capture (no chart exists yet) is gated by the permission +
// step-up alone. Widening the org-wide list is a separate, deliberate decision (org-wide-scope.ts explains why
// `org_admin` is excluded).
//
// NOT a `system_locked` floor: a tenant may remove a key from a role it owns. This is the single source the backfill
// migration `0801` and the dev-seed grant are pinned to (the INTAKE_DEFAULT_GRANTS / `0374` precedent).
export const SSN_WRITE_KEY = "phi.write_ssn";
export const SSN_READ_KEY = "phi.read_ssn";

/** Roles that may STORE an SSN / state id. */
export const SSN_WRITE_ROLE_KEYS = [
  "intake_supervisor",
  "billing_manager",
  "org_admin",
  "administrator",
] as const;

/** Roles that may REVEAL a stored value: the writers plus the compliance officer. */
export const SSN_READ_ROLE_KEYS = [...SSN_WRITE_ROLE_KEYS, "compliance_officer"] as const;

export type SsnGrantRoleKey = (typeof SSN_READ_ROLE_KEYS)[number];

export const SSN_DEFAULT_GRANTS: Readonly<Record<SsnGrantRoleKey, readonly string[]>> =
  Object.freeze({
    intake_supervisor: [SSN_WRITE_KEY, SSN_READ_KEY],
    billing_manager: [SSN_WRITE_KEY, SSN_READ_KEY],
    org_admin: [SSN_WRITE_KEY, SSN_READ_KEY],
    administrator: [SSN_WRITE_KEY, SSN_READ_KEY],
    compliance_officer: [SSN_READ_KEY],
  });

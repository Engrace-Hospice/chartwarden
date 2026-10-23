/**
 * M14 §"Permissions" default roles for the two IDG keys the category sweep would otherwise hand to every
 * clinical role (docs/modules/CHARTWARDEN_MODULE_14_IDG_SPEC_v0_4.md, `idg.coordinate` / `idg.schedule`).
 * `idg.coordinate` builds packets and runs the meeting lifecycle; `idg.schedule` manages policies and
 * cancels/reschedules — neither belongs to an aide, a volunteer or a bedside nurse. Roles seeded with the
 * whole catalog (`administrator`, `org_admin` — the spec's Tenant Admin) are not filtered through this.
 *
 * It also holds `triage.paper_reentry` (#640): categorised `compliance` (M19 decision 3), so the category sweep
 * hands it to the read-only `auditor`, but it is the one M19 write that can back-date a call past a coverage gap.
 * M19 §2.7 gives it to the org admin or DON; a Compliance Officer keeps it (a role that acts, unlike an auditor).
 */
const IDG_KEY_ROLES: Readonly<Record<string, ReadonlySet<string>>> = {
  "idg.coordinate": new Set(["clinical_supervisor", "medical_director"]),
  "idg.schedule": new Set(["clinical_supervisor", "medical_director"]),
  "triage.paper_reentry": new Set(["clinical_supervisor", "compliance_officer"]),
};

/** True unless `permissionKey` is a restricted IDG key and `roleKey` is not one of its default roles. */
export function roleMayHoldPermission(roleKey: string, permissionKey: string): boolean {
  const allowed = IDG_KEY_ROLES[permissionKey];
  return allowed === undefined || allowed.has(roleKey);
}

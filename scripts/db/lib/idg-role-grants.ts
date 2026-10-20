/**
 * M14 §"Permissions" default roles for the two IDG keys the category sweep would otherwise hand to every
 * clinical role (docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md, `idg.coordinate` / `idg.schedule`).
 * `idg.coordinate` builds packets and runs the meeting lifecycle; `idg.schedule` manages policies and
 * cancels/reschedules — neither belongs to an aide, a volunteer or a bedside nurse. Roles seeded with the
 * whole catalog (`administrator`, `org_admin` — the spec's Tenant Admin) are not filtered through this.
 */
const IDG_KEY_ROLES: Readonly<Record<string, ReadonlySet<string>>> = {
  "idg.coordinate": new Set(["clinical_supervisor", "medical_director"]),
  "idg.schedule": new Set(["clinical_supervisor", "medical_director"]),
};

/** True unless `permissionKey` is a restricted IDG key and `roleKey` is not one of its default roles. */
export function roleMayHoldPermission(roleKey: string, permissionKey: string): boolean {
  const allowed = IDG_KEY_ROLES[permissionKey];
  return allowed === undefined || allowed.has(roleKey);
}

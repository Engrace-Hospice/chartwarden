// apps/backend/src/modules/31-portal/permission-keys.ts — M31-T07 (§4.6).
//
// The forty-seven permission keys Module 31 registers into Module 3's catalog. The canonical map is
// `M31_CONTRIBUTED_PERMISSIONS` in @wardenx/auth (merged into the platform mirror via
// `allPermissionMirrorRows`); this module-local surface re-exports it plus the ordered key list, so the
// §4.1 routes gate on `requirePermission(key)` without re-declaring the map (the M20/M19/M32 posture —
// references the auth package directly, no drift).
import { type M31ContributedPermissionKey, M31_CONTRIBUTED_PERMISSIONS } from "@wardenx/auth";

export { M31_CONTRIBUTED_PERMISSIONS, type M31ContributedPermissionKey } from "@wardenx/auth";

/** Union of every §4.6 permission key M31 owns. */
export type M31PermissionKey = M31ContributedPermissionKey;

/** The ordered §4.6 key list (the §4.1 route inventory gates on these). */
export const M31_PERMISSION_KEY_LIST = Object.keys(
  M31_CONTRIBUTED_PERMISSIONS,
) as M31PermissionKey[];

/**
 * §4.1 — the keys whose routes carry an M2 step-up gate ON TOP of the permission.
 *
 * §4.1's Step-up column marks four rows "yes": the caregiver-attested administration (TOTP), the amendment
 * submit (TOTP), the account suspend/reinstate, and the compliance-officer recording halt. Kept as an
 * explicit list rather than a naming convention so the §9 test asserts the route layer composes
 * `requireStepUp` on exactly these and a future key cannot silently join or leave the set.
 */
export const M31_STEP_UP_PERMISSION_KEYS: readonly M31PermissionKey[] = [
  "portal.administration.attest",
  "portal.amendment.submit",
  "portal.account.suspend",
  "portal.account.reinstate",
  "telehealth.record_start",
  "telehealth.record_halt_admin",
];

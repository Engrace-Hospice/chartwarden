// apps/backend/src/modules/15-discipline-care-plans/permission-keys.ts — M15-T06 (§4.4).
//
// The twenty permission keys Module 15 (Discipline Care Plans) registers into Module 3's catalog. The
// canonical map is `M15_CONTRIBUTED_PERMISSIONS` in @wardenx/auth (merged into the platform mirror via
// `allPermissionMirrorRows`); this module-local surface re-exports it + the ordered key list so the §4.1
// routes gate on `requirePermission(key)` without re-declaring the map (the M24/M26 posture — references
// the auth package directly, no drift).
import { M15_CONTRIBUTED_PERMISSIONS, type M15ContributedPermissionKey } from "@wardenx/auth";

export { M15_CONTRIBUTED_PERMISSIONS, type M15ContributedPermissionKey } from "@wardenx/auth";

/** Union of every §4.4 permission key M15 owns. */
export type M15PermissionKey = M15ContributedPermissionKey;

/** The ordered §4.4 key list (the §4.1 route inventory gates on these). */
export const M15_PERMISSION_KEY_LIST = Object.keys(
  M15_CONTRIBUTED_PERMISSIONS,
) as M15PermissionKey[];

/**
 * The three §4.1 seam routes (25–28) are SYSTEM-principal only: they carry PHI-derived facts across the
 * module boundary for M8/M14/M16/M17/M22 and are never granted to a human role template. Kept as an
 * explicit list so the route layer (and a future role-template seed) can assert the exclusion rather than
 * relying on a naming convention.
 */
export const M15_INTERNAL_PERMISSION_KEYS: readonly M15PermissionKey[] = [
  "discipline_plan.read_internal",
  "volunteer_compliance.read_internal",
  "aide_supervisory.read_internal",
];

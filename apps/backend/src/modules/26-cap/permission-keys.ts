// apps/backend/src/modules/26-cap/permission-keys.ts — M26 (§4.6).
//
// The fourteen permission keys Module 26 (Cap Management) registers into Module 3's catalog. The canonical
// map is `M26_CONTRIBUTED_PERMISSIONS` in @wardenx/auth (merged into the platform mirror via
// allPermissionMirrorRows); this module-local surface re-exports it + the ordered key list so the §4.1
// routes gate on `requirePermission(key)` without re-declaring the map (the M25 posture — references the
// auth package directly, no drift).
import { type M26ContributedPermissionKey, M26_CONTRIBUTED_PERMISSIONS } from "@wardenx/auth";

export { M26_CONTRIBUTED_PERMISSIONS, type M26ContributedPermissionKey } from "@wardenx/auth";

/** Union of every §4.6 permission key M26 owns. */
export type M26PermissionKey = M26ContributedPermissionKey;

/** The ordered §4.6 key list (the route inventory gates on these). */
export const M26_PERMISSION_KEY_LIST = Object.keys(
  M26_CONTRIBUTED_PERMISSIONS,
) as M26PermissionKey[];

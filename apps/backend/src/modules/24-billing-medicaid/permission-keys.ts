// apps/backend/src/modules/24-billing-medicaid/permission-keys.ts — M24 (§4.7).
//
// The twenty-six permission keys Module 24 (Billing — Medicaid) registers into Module 3's catalog. The
// canonical map is `M24_CONTRIBUTED_PERMISSIONS` in @wardenx/auth (merged into the platform mirror via
// allPermissionMirrorRows); this module-local surface re-exports it + the ordered key list so the §4.1
// routes gate on `requirePermission(key)` without re-declaring the map (the M26 posture — references the
// auth package directly, no drift).
import { M24_CONTRIBUTED_PERMISSIONS, type M24ContributedPermissionKey } from "@wardenx/auth";

export { M24_CONTRIBUTED_PERMISSIONS, type M24ContributedPermissionKey } from "@wardenx/auth";

/** Union of every §4.7 permission key M24 owns. */
export type M24PermissionKey = M24ContributedPermissionKey;

/** The ordered §4.7 key list (the route inventory gates on these). */
export const M24_PERMISSION_KEY_LIST = Object.keys(
  M24_CONTRIBUTED_PERMISSIONS,
) as M24PermissionKey[];

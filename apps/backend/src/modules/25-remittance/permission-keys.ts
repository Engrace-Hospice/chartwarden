// apps/backend/src/modules/25-remittance/permission-keys.ts — M25 (§4.6).
//
// The twenty-two permission keys Module 25 (Remittance & Denials) registers into Module 3's catalog. The
// canonical map is `M25_CONTRIBUTED_PERMISSIONS` in @wardenx/auth (the single source merged into the
// platform mirror via allPermissionMirrorRows); this module-local surface re-exports it + the ordered key
// list so the §4.1 routes gate on `requirePermission(key)` without re-declaring the map (no drift — unlike
// the M23 self-contained mirror, M25 references the auth package directly).
import { type M25ContributedPermissionKey, M25_CONTRIBUTED_PERMISSIONS } from "@wardenx/auth";

export { M25_CONTRIBUTED_PERMISSIONS, type M25ContributedPermissionKey } from "@wardenx/auth";

/** Union of every §4.6 permission key M25 owns. */
export type M25PermissionKey = M25ContributedPermissionKey;

/** The ordered §4.6 key list (the route inventory gates on these). */
export const M25_PERMISSION_KEY_LIST = Object.keys(
  M25_CONTRIBUTED_PERMISSIONS,
) as M25PermissionKey[];

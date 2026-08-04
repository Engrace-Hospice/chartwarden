// apps/backend/src/modules/16-bereavement/permission-keys.ts — M16-T06 (§4.7).
//
// The twenty-nine permission keys Module 16 (Bereavement) registers into Module 3's catalog. The canonical
// map is `M16_CONTRIBUTED_PERMISSIONS` in @wardenx/auth (merged into the platform mirror via
// `allPermissionMirrorRows`); this module-local surface re-exports it + the ordered key list so the §4.1
// routes gate on `requirePermission(key)` without re-declaring the map (the M15/M24/M26 posture —
// references the auth package directly, no drift).
import { type M16ContributedPermissionKey, M16_CONTRIBUTED_PERMISSIONS } from "@wardenx/auth";

export { M16_CONTRIBUTED_PERMISSIONS, type M16ContributedPermissionKey } from "@wardenx/auth";

/** Union of every §4.7 permission key M16 owns. */
export type M16PermissionKey = M16ContributedPermissionKey;

/** The ordered §4.7 key list (the §4.1 route inventory gates on these). */
export const M16_PERMISSION_KEY_LIST = Object.keys(
  M16_CONTRIBUTED_PERMISSIONS,
) as M16PermissionKey[];

/**
 * §4.7 — the two keys a bereaved family member's own M31 portal session may hold ("portal-self (contact's
 * own session)"). Kept as an explicit list so the route layer can assert that the portal-self ABAC branch
 * is only ever composed on these two, rather than relying on a naming convention: every OTHER M16 key is
 * staff-only, and a portal session that somehow acquired one must still fail `bereavement_window`.
 */
export const M16_PORTAL_SELF_PERMISSION_KEYS: readonly M16PermissionKey[] = [
  "bereavement.contact.opt_out",
  "bereavement.contact.rescind_opt_out",
];

// apps/backend/src/modules/28-fhir/permission-keys.ts — M28-T08 (§4.6).
//
// The twelve permission keys Module 28 registers into Module 3's catalog. The canonical map is
// `M28_CONTRIBUTED_PERMISSIONS` in @wardenx/auth (merged into the platform mirror via
// `allPermissionMirrorRows`); this module-local surface re-exports it plus the ordered key list, so the
// §4.1 admin routes gate on `requirePermission(key)` without re-declaring the map (the M32 posture —
// references the auth package directly, no drift).
import { type M28ContributedPermissionKey, M28_CONTRIBUTED_PERMISSIONS } from "@wardenx/auth";

export { M28_CONTRIBUTED_PERMISSIONS, type M28ContributedPermissionKey } from "@wardenx/auth";

/** Union of every §4.6 admin permission key M28 owns. */
export type M28PermissionKey = M28ContributedPermissionKey;

/** The ordered §4.6 key list (the §4.1 admin route inventory gates on these). */
export const M28_PERMISSION_KEY_LIST = Object.keys(
  M28_CONTRIBUTED_PERMISSIONS,
) as M28PermissionKey[];

/**
 * §4.1 — the keys whose routes carry an M2 step-up gate ON TOP of the permission.
 *
 * One act: rotating the per-tenant HMAC cursor-signing key (R39) invalidates every outstanding signed
 * search cursor, so §4.1 spells it `+ step-up`. The set is short and pinned so a future key cannot
 * silently join or leave it.
 */
export const M28_STEP_UP_PERMISSION_KEYS: readonly M28PermissionKey[] = ["fhir.config.write"];

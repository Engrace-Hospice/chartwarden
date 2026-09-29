// apps/backend/src/modules/21-supplies/permission-keys.ts — M21-T05 (§4.3).
//
// The twenty-nine permission keys Module 21 registers into Module 3's catalog. The canonical map is
// `M21_CONTRIBUTED_PERMISSIONS` in @wardenx/auth (merged into the platform mirror via
// `allPermissionMirrorRows`); this module-local surface re-exports it + the ordered key list so the §4.1
// routes gate on `requirePermission(key)` without re-declaring the map (the M15/M16/M24/M26 posture —
// references the auth package directly, no drift).
import { type M21ContributedPermissionKey, M21_CONTRIBUTED_PERMISSIONS } from "@wardenx/auth";

export { M21_CONTRIBUTED_PERMISSIONS, type M21ContributedPermissionKey } from "@wardenx/auth";

/** Union of every §4.3 permission key M21 owns. */
export type M21PermissionKey = M21ContributedPermissionKey;

/** The ordered §4.3 key list (the §4.1 route inventory gates on these). */
export const M21_PERMISSION_KEY_LIST = Object.keys(
  M21_CONTRIBUTED_PERMISSIONS,
) as M21PermissionKey[];

/**
 * §4.3 — the three keys marked "(platform-only)". `supply_item` carries no organization_id at all (D11),
 * so these govern the PLATFORM catalog loader, not a tenant surface. Kept as an explicit list rather than
 * a naming convention so the route layer can assert the platform gate is composed on exactly these and a
 * future `supplies.item.*` key cannot silently join the set.
 */
export const M21_PLATFORM_ONLY_PERMISSION_KEYS: readonly M21PermissionKey[] = [
  "supplies.item.write",
  "supplies.item.retire",
];

/**
 * §4.3 / §8.1 — the keys that read or write the DEA 21 CFR §1304 controlled-substance record. Every one of
 * them is `compliance` category in the catalog and every route that binds one carries a §4.4 ABAC gate or
 * the perpetual-log read key. Listed here because §8.2 tags the resulting audit rows
 * `retention_class = 'regulatory_dea'`, and that tagging keys off the permission the request evaluated.
 */
export const M21_CONTROLLED_SUBSTANCE_PERMISSION_KEYS: readonly M21PermissionKey[] = [
  "comfort_kit.dispatch.create",
  "comfort_kit.return.reconcile",
  "comfort_kit.return.declare_unreturnable",
  "comfort_kit.perpetual_log.read",
];

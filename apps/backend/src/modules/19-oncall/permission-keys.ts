// apps/backend/src/modules/19-oncall/permission-keys.ts — M19-T07 (§4.6).
//
// The seventeen permission keys Module 19 registers into Module 3's catalog. The canonical map is
// `M19_CONTRIBUTED_PERMISSIONS` in @chartwarden/auth (merged into the platform mirror via
// `allPermissionMirrorRows`); this module-local surface re-exports it plus the ordered key list, so the
// §4.1 routes gate on `requirePermission(key)` without re-declaring the map (the M15/M16/M21/M24/M26
// posture — references the auth package directly, no drift).
import { type M19ContributedPermissionKey, M19_CONTRIBUTED_PERMISSIONS } from "@chartwarden/auth";

export { M19_CONTRIBUTED_PERMISSIONS, type M19ContributedPermissionKey } from "@chartwarden/auth";

/** Union of every §4.6 permission key M19 owns. */
export type M19PermissionKey = M19ContributedPermissionKey;

/** The ordered §4.6 key list (the §4.1 route inventory gates on these). */
export const M19_PERMISSION_KEY_LIST = Object.keys(
  M19_CONTRIBUTED_PERMISSIONS,
) as M19PermissionKey[];

/**
 * §4.1 — the keys whose routes carry an M2 step-up gate ON TOP of the permission.
 *
 * §4.1's table marks three rows "(step-up)" — the policy PATCH (26), the protocol admin writes (29-32)
 * and the vendor binding writes (34-35) — and §4.1 row 14 makes the transcript decrypt a step-up read in
 * its Notes column. `triage.paper_reentry` is §4.6's own parenthetical ("step-up required").
 *
 * Kept as an explicit list rather than a naming convention so the §9 test can assert the route layer
 * composes `requireStepUp` on exactly these and a future key cannot silently join or leave the set. The
 * verbal-order path (§7.7 / D9) is deliberately ABSENT: its step-up is asserted inside
 * `clinical/verbal-order.ts` against the M11 seam call, not at the route, because the gate must hold for
 * the seam invocation and not merely for the HTTP request that started it.
 */
export const M19_STEP_UP_PERMISSION_KEYS: readonly M19PermissionKey[] = [
  "triage.read_transcript",
  "triage.admin_protocol",
  "oncall.admin_policy",
  "triage.paper_reentry",
];

/**
 * §6 / §8.7 — the keys whose routes touch the external-vendor (Ext Triage Op) surface, i.e. the ones a
 * `external_triage_vendor` session class may hold at all. §6's last column grants the vendor operator
 * exactly `triage.open`, `triage.read`, `triage.write`, `triage.disposition` and `triage.escalate`; every
 * other key in the catalog is in-agency only.
 *
 * This list is what the §8.7.2 `triage.vendor_access` audit entry keys off, and what the route layer
 * asserts before it lets a vendor-class session past `external_triage_actor`. A key NOT on this list held
 * by a vendor session is a mis-provisioned grant, and the route refuses rather than trusting the grant.
 */
export const M19_VENDOR_SESSION_PERMISSION_KEYS: readonly M19PermissionKey[] = [
  "triage.open",
  "triage.read",
  "triage.write",
  "triage.disposition",
  "triage.escalate",
];

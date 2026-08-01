// apps/backend/src/modules/20-field-safety/permission-keys.ts — M20-T06 (§4.6).
//
// The twenty-five permission keys Module 20 registers into Module 3's catalog. The canonical map is
// `M20_CONTRIBUTED_PERMISSIONS` in @wardenx/auth (merged into the platform mirror via
// `allPermissionMirrorRows`); this module-local surface re-exports it plus the ordered key list, so the
// §4.1 routes gate on `requirePermission(key)` without re-declaring the map (the M15/M16/M19/M21/M24/M26
// posture — references the auth package directly, no drift).
import { M20_CONTRIBUTED_PERMISSIONS, type M20ContributedPermissionKey } from "@wardenx/auth";

export { M20_CONTRIBUTED_PERMISSIONS, type M20ContributedPermissionKey } from "@wardenx/auth";

/** Union of every §4.6 permission key M20 owns. */
export type M20PermissionKey = M20ContributedPermissionKey;

/** The ordered §4.6 key list (the §4.1 route inventory gates on these). */
export const M20_PERMISSION_KEY_LIST = Object.keys(
  M20_CONTRIBUTED_PERMISSIONS,
) as M20PermissionKey[];

/**
 * §4.1 — the keys whose routes carry an M2 step-up gate ON TOP of the permission.
 *
 * §4.1's table marks exactly two rows "∧ step-up": the OSHA sign-off (row 17) and the policy PATCH
 * (row 19); §6's "Override and step-up workflows" block names the same two. Kept as an explicit list
 * rather than a naming convention so the §9 test can assert the route layer composes `requireStepUp` on
 * exactly these and a future key cannot silently join or leave the set.
 *
 * `safety.sos.cancel` is DELIBERATELY ABSENT even though D5's cancel demands a BIOMETRIC. The two are
 * different gates and conflating them would break the one scenario D5 exists for: step-up is an M2
 * SESSION property (re-authenticate, then the session carries `stepUpRecent` for a window), whereas D5's
 * biometric is a PER-ACT device verdict presented at the moment of the tap. A hostile actor holding an
 * already-stepped-up phone would sail past a `requireStepUp`; the biometric verdict rides the cancel BODY
 * and is decided by `cancelSos` (../lifecycle/sos-alert.ts) against the tenant's policy.
 *
 * `safety.sos.read_coords` is also absent: §4.1 marks it "yes (warn)" in the READ-AUDIT column, not the
 * ABAC one. Its control is the warn-severity audit row plus the clinician's own self-service surface
 * (§8.7), not a second authentication.
 */
export const M20_STEP_UP_PERMISSION_KEYS: readonly M20PermissionKey[] = [
  "safety_incident.osha_signoff",
  "safety_policy.edit",
];

/**
 * §4.1 — the keys whose routes emit a `warn`-severity M4 read-audit entry rather than the default `info`.
 *
 * §4.1's Read-Audit column says "yes (warn)" on exactly three rows: the location-stream read (row 10),
 * the OSHA sign-off (row 17) and the policy PATCH (row 19). The first is §8.7's coordinate boundary — the
 * read the clinician can later see on her own consent surface. The other two are writes whose read-audit
 * marker is what a compliance review scans for.
 *
 * Held here rather than inline in each route file so §9.5's test asserts the SET, not three separate
 * spellings of a config literal.
 */
export const M20_WARN_READ_AUDIT_PERMISSION_KEYS: readonly M20PermissionKey[] = [
  "safety.sos.read_coords",
  "safety_incident.osha_signoff",
  "safety_policy.edit",
];

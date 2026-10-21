// apps/backend/src/modules/29-external-interfaces/permission-keys.ts — M29-T08 (§4.7).
//
// The twenty-one permission keys Module 29 registers into Module 3's catalog. The canonical map is
// `M29_CONTRIBUTED_PERMISSIONS` in @chartwarden/auth (merged into the platform mirror via
// `allPermissionMirrorRows`); this module-local surface re-exports it plus the ordered key list and the
// step-up subset, so the §4.1/§4.2 routes gate on `requirePermission(key)` / `requireStepUp(key)` without
// re-declaring the map (the M28/M32 posture — references the auth package directly, no drift).
import { type M29ContributedPermissionKey, M29_CONTRIBUTED_PERMISSIONS } from "@chartwarden/auth";

export {
  M29_CONTRIBUTED_PERMISSIONS,
  type M29ContributedPermissionKey,
} from "@chartwarden/auth";

/** Union of every §4.7 permission key M29 owns. */
export type M29PermissionKey = M29ContributedPermissionKey;

/** The ordered §4.7 key list (the §4.1/§4.2 route inventory gates on these). */
export const M29_PERMISSION_KEY_LIST = Object.keys(
  M29_CONTRIBUTED_PERMISSIONS,
) as M29PermissionKey[];

/**
 * §4.1/§4.2 (D18) — the keys whose routes carry an M2 SESSION_POLICY step-up gate ON TOP of the permission.
 *
 * Every one is a compliance-consequential act: mutating a feed configuration, rotating a channel secret,
 * accepting/rejecting an ADT demographic proposal, decrypting a stored HL7 payload for review, replaying or
 * retrying a message, triggering a platform NPPES sync, and the two unmatched-lab adjudications. The set is
 * pinned so a future key cannot silently join or leave it.
 */
export const M29_STEP_UP_PERMISSION_KEYS: readonly M29PermissionKey[] = [
  "external_interfaces.feed.create",
  "external_interfaces.feed.update",
  "external_interfaces.feed.activate",
  "external_interfaces.feed.suspend",
  "external_interfaces.feed.revoke",
  "external_interfaces.credential.rotate",
  "external_interfaces.proposal.accept",
  "external_interfaces.proposal.reject",
  "external_interfaces.message.read_plaintext",
  "external_interfaces.message.replay",
  "external_interfaces.message.retry",
  "external_interfaces.nppes.sync_trigger",
  "external_interfaces.lab.review_unmatched",
];

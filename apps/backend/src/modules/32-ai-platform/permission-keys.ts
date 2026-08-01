// apps/backend/src/modules/32-ai-platform/permission-keys.ts — M32-T07 (§4.6).
//
// The twenty-two permission keys Module 32 registers into Module 3's catalog. The canonical map is
// `M32_CONTRIBUTED_PERMISSIONS` in @wardenx/auth (merged into the platform mirror via
// `allPermissionMirrorRows`); this module-local surface re-exports it plus the ordered key list, so the
// §4.1 routes gate on `requirePermission(key)` without re-declaring the map (the M15/M16/M19/M20/M21
// posture — references the auth package directly, no drift).
import { M32_CONTRIBUTED_PERMISSIONS, type M32ContributedPermissionKey } from "@wardenx/auth";

export { M32_CONTRIBUTED_PERMISSIONS, type M32ContributedPermissionKey } from "@wardenx/auth";

/** Union of every §4.6 permission key M32 owns. */
export type M32PermissionKey = M32ContributedPermissionKey;

/** The ordered §4.6 key list (the §4.1 route inventory gates on these). */
export const M32_PERMISSION_KEY_LIST = Object.keys(
  M32_CONTRIBUTED_PERMISSIONS,
) as M32PermissionKey[];

/**
 * §4.1 — the keys whose routes carry an M2 step-up gate ON TOP of the permission.
 *
 * §4.1's table declares no step-up column, so this list is derived from §8.1's STRIDE elevation controls
 * and §2.2's own signer requirements, and it is deliberately SHORT — three acts whose blast radius leaves
 * the tenant that performed them:
 *
 *   · `ai.kill_switch.activate` — R7/R8. A PLATFORM-scoped switch stops a capability for every agency on
 *     the deployment, and R8 (deactivate) is the direction that RESUMES a capability somebody paused
 *     during an incident. A stolen session that could un-pause a SEV-1 kill switch would undo the one
 *     control D8 exists to provide.
 *   · `ai.capability.transition` — R4. §2.2's stage-4 → stage-5 edge is what makes a capability servable
 *     to real charts; the ledger row it writes is the platform's evidence of who approved that.
 *   · `ai.prompt.activate` — R30. §4.5/§8.5: the active template is what every consumer's D18 prohibited-
 *     zone validator reads at boot. Swapping it is the highest-leverage write in the module.
 *
 * `ai.capability.create` is NOT here on purpose: PROPOSED serves nothing (§2.2), so registering a
 * capability changes no clinician's screen. `ai.tenant_opt_in` is not here either — §5.3's gate is the
 * ACKNOWLEDGMENT evidence (W4.1), and stacking a re-auth on top would train tenant admins to step up for
 * a form rather than for a consequence.
 */
export const M32_STEP_UP_PERMISSION_KEYS: readonly M32PermissionKey[] = [
  "ai.kill_switch.activate",
  "ai.capability.transition",
  "ai.prompt.activate",
];

/**
 * §4.1 — the keys whose routes emit an M4 read-audit entry.
 *
 * `ai.invocation.read` is the ONLY one, and that is the §3.2.8 contract speaking rather than a policy
 * choice: an `ai_invocation` row names a patient whose chart context was disclosed to a model vendor, so
 * READING the ledger is itself a PHI access. Every other M32 read surface (capabilities, kill switches,
 * evaluation runs, prompt metadata, backend health, the token ledger) is platform-shared or
 * aggregate-by-construction and carries no patient identity at all — auditing them would bury the one
 * entry a §164.528 review is looking for under thousands that mean nothing.
 */
export const M32_READ_AUDITED_PERMISSION_KEYS: readonly M32PermissionKey[] = ["ai.invocation.read"];

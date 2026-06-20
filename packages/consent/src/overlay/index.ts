// @wardenx/consent — the tenant-overlay TIGHTEN-ONLY validator (M39-T09, §7.6, D2/D8).
//
// A tenant may TIGHTEN a platform consent-type floor, never LOOSEN it. The platform ships the floor
// (consent_type_catalog); a `tenant_consent_type_overlay` may only narrow it:
//   • expiration — a SHORTER term (≤ the floor default; an indefinite floor accepts any finite term);
//   • capture methods — a SUBSET of the allowed floor set (introducing a method the platform does not
//     permit is a LOOSEN — `overlay_loosens_platform_floor`);
//   • reminders — a SUPERSET of the floor cadence (MORE reminders, never fewer);
//   • jurisdiction requirement — may go false→true (tighten), never true→false (loosen).
// Route 2 (POST /consent-types/overlay) runs this on publish; a loosen attempt is a 422 + an M4
// `severity='warn'` audit. Pure — the route maps the refusal to the HTTP envelope.
import { type ConsentCaptureMethod, type ConsentReminderKind } from "../interfaces/kinds";
import { type Decision, deny, ok } from "../lifecycle/result";

export interface ConsentTypeFloor {
  /** null = indefinite (no platform expiry). */
  readonly defaultExpirationSeconds: number | null;
  readonly captureMethodFloor: readonly ConsentCaptureMethod[];
  readonly reminderCadenceFloor: readonly ConsentReminderKind[];
  readonly jurisdictionCodeRequired: boolean;
}

export interface ConsentTypeOverlay {
  readonly tighterExpirationSeconds?: number | null;
  readonly tighterCaptureMethods?: readonly ConsentCaptureMethod[];
  readonly tighterReminderCadence?: readonly ConsentReminderKind[];
  readonly jurisdictionCodeRequired?: boolean;
}

/** Validate that `overlay` only tightens `floor` (§7.6). Returns a stable refusal on any loosen. */
export function validateConsentOverlay(floor: ConsentTypeFloor, overlay: ConsentTypeOverlay): Decision {
  // 1. Expiration — must be a positive, shorter-or-equal term.
  if (overlay.tighterExpirationSeconds !== undefined && overlay.tighterExpirationSeconds !== null) {
    if (overlay.tighterExpirationSeconds <= 0)
      return deny("overlay_loosens_platform_floor", "tighter expiration must be a positive duration");
    if (
      floor.defaultExpirationSeconds !== null &&
      overlay.tighterExpirationSeconds > floor.defaultExpirationSeconds
    )
      return deny("overlay_loosens_platform_floor", "tighter expiration cannot exceed the platform floor (a longer term loosens)");
  }

  // 2. Capture methods — a subset of the floor (a method outside the floor is a loosen).
  if (overlay.tighterCaptureMethods !== undefined) {
    const floorSet = new Set<ConsentCaptureMethod>(floor.captureMethodFloor);
    for (const m of overlay.tighterCaptureMethods)
      if (!floorSet.has(m))
        return deny("overlay_loosens_platform_floor", `capture method '${m}' is not in the platform floor (loosen)`);
  }

  // 3. Reminders — a superset of the floor (fewer reminders loosens).
  if (overlay.tighterReminderCadence !== undefined) {
    const tighterSet = new Set<ConsentReminderKind>(overlay.tighterReminderCadence);
    for (const r of floor.reminderCadenceFloor)
      if (!tighterSet.has(r))
        return deny("overlay_loosens_platform_floor", `reminder '${r}' from the platform floor is missing (loosen)`);
  }

  // 4. Jurisdiction requirement — may only go false→true.
  if (overlay.jurisdictionCodeRequired === false && floor.jurisdictionCodeRequired === true)
    return deny("overlay_loosens_platform_floor", "cannot relax a required jurisdiction code (loosen)");

  return ok();
}

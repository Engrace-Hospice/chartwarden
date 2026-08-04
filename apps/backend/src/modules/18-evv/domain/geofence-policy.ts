// apps/backend/src/modules/18-evv/domain/geofence-policy.ts — M18-T03 (§2.2.2 D3, §2.3, §2.5).
//
// The pure three-layer geofence-policy resolver + the tighten-only edit constraints. The §2.2.2 model is
// strict precedence: a seeded platform floor (scope='platform', radius_m=200, max_accuracy_m=50) → a tenant
// default → per-patient-address overrides. The effective policy for a visit is the NARROWEST applicable
// layer's settings; edits create a NEW row (auditable history) and may only TIGHTEN — never loosen above the
// parent layer. All functions are IO-free; the service layer (M18-T06) loads the active rows under RLS and
// feeds them here. The §2.3 bounds (`radius_m ∈ [50,1000]`, `max_accuracy_m ∈ [5,100]`) are mirrored by DB
// CHECKs (M18-T02) as defense in depth.
import type { EvvGeofencePolicyScope } from "@wardenx/types";
import { require_ } from "./errors";
import type { GeofenceSettings } from "./geofence";

/** §2.2.2 / Phase-D — the seeded platform-floor radius (metres). */
export const PLATFORM_FLOOR_RADIUS_M = 200;
/** §2.2.2 / Phase-D — the seeded platform-floor max accuracy (metres). */
export const PLATFORM_FLOOR_MAX_ACCURACY_M = 50;

/** §2.3 — the absolute radius bounds any layer may set (metres). */
export const GEOFENCE_RADIUS_MIN_M = 50;
export const GEOFENCE_RADIUS_MAX_M = 1000;
/** §2.3 — the absolute max-accuracy bounds any layer may set (metres). */
export const GEOFENCE_MAX_ACCURACY_MIN_M = 5;
export const GEOFENCE_MAX_ACCURACY_MAX_M = 100;

/** §2.2.2 — the minimum `override_reason` length for a `patient_address` layer (chars). */
export const GEOFENCE_OVERRIDE_REASON_MIN = 30;

/** One active geofence-policy layer (a projection of an `evv_geofence_policy` row, no PHI). */
export interface GeofencePolicyLayer extends GeofenceSettings {
  readonly scope: EvvGeofencePolicyScope;
  /** Non-null only when `scope === 'patient_address'`. */
  readonly patientAddressId: string | null;
}

/** Layer precedence: the narrowest scope wins. */
const SCOPE_RANK: Record<EvvGeofencePolicyScope, number> = {
  platform: 0,
  tenant: 1,
  patient_address: 2,
};

/**
 * Resolve the §2.2.2 effective policy for a visit: the narrowest applicable layer. A `patient_address` layer
 * applies only when its `patientAddressId` matches the visit's address. Throws when no layer resolves (the
 * platform floor is always seeded, so this only fires on a misconfigured fixture).
 */
export function resolveEffectivePolicy(
  layers: readonly GeofencePolicyLayer[],
  patientAddressId: string | null,
): GeofenceSettings {
  const applicable = layers.filter(
    (l) =>
      l.scope !== "patient_address" ||
      (patientAddressId !== null && l.patientAddressId === patientAddressId),
  );
  require_(
    applicable.length > 0,
    "GEOFENCE_POLICY_LAYER_UNRESOLVED",
    "No applicable geofence policy layer (the platform floor must be seeded).",
  );
  const narrowest = applicable.reduce((acc, layer) =>
    SCOPE_RANK[layer.scope] > SCOPE_RANK[acc.scope] ? layer : acc,
  );
  return { radiusM: narrowest.radiusM, maxAccuracyM: narrowest.maxAccuracyM };
}

/** §2.3 — assert a layer's radius/accuracy are within the absolute bounds (the DB CHECK mirror). */
export function assertPolicyBounds(settings: GeofenceSettings): void {
  require_(
    settings.radiusM >= GEOFENCE_RADIUS_MIN_M && settings.radiusM <= GEOFENCE_RADIUS_MAX_M,
    "GEOFENCE_RADIUS_OUT_OF_RANGE",
    `radius_m must be within [${GEOFENCE_RADIUS_MIN_M}, ${GEOFENCE_RADIUS_MAX_M}].`,
  );
  require_(
    settings.maxAccuracyM >= GEOFENCE_MAX_ACCURACY_MIN_M &&
      settings.maxAccuracyM <= GEOFENCE_MAX_ACCURACY_MAX_M,
    "GEOFENCE_MAX_ACCURACY_OUT_OF_RANGE",
    `max_accuracy_m must be within [${GEOFENCE_MAX_ACCURACY_MIN_M}, ${GEOFENCE_MAX_ACCURACY_MAX_M}].`,
  );
}

/**
 * §2.2.2 tighten-only — a narrower layer may only NARROW (a smaller radius and a smaller accuracy tolerance)
 * relative to its parent layer; it may never loosen above the parent. The platform floor is the parent of the
 * tenant default; the tenant default (or the platform floor) is the parent of a per-address override.
 */
export function assertTightenOnly(parent: GeofenceSettings, child: GeofenceSettings): void {
  require_(
    child.radiusM <= parent.radiusM && child.maxAccuracyM <= parent.maxAccuracyM,
    "GEOFENCE_POLICY_NOT_TIGHTENING",
    "A narrower geofence layer may only tighten (smaller radius + accuracy tolerance), never loosen.",
  );
}

/**
 * §2.2.2 — validate a proposed policy edit before the new row is written: bounds, the tighten-only constraint
 * against the parent layer, and (for a `patient_address` override) the ≥30-char reason floor.
 */
export function validatePolicyEdit(input: {
  readonly scope: EvvGeofencePolicyScope;
  readonly proposed: GeofenceSettings;
  readonly parent: GeofenceSettings;
  readonly overrideReason?: string;
}): void {
  assertPolicyBounds(input.proposed);
  assertTightenOnly(input.parent, input.proposed);
  if (input.scope === "patient_address") {
    require_(
      (input.overrideReason?.trim().length ?? 0) >= GEOFENCE_OVERRIDE_REASON_MIN,
      "GEOFENCE_OVERRIDE_REASON_TOO_SHORT",
      `A patient_address override requires an override_reason ≥ ${GEOFENCE_OVERRIDE_REASON_MIN} chars.`,
    );
  }
}

/** The seeded platform-floor settings (the resolver's root parent + the Phase-D seed values). */
export const PLATFORM_FLOOR_SETTINGS: GeofenceSettings = {
  radiusM: PLATFORM_FLOOR_RADIUS_M,
  maxAccuracyM: PLATFORM_FLOOR_MAX_ACCURACY_M,
};

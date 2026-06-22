// apps/backend/src/modules/18-evv/domain/geofence.ts — M18-T03 (§2.2.6, §2.4, §7.1, §7.5, §7.6).
//
// The pure geofence math the §2.2.6 `evv_geofence_evaluation` snapshot is built from and the §3.2
// `evv_event_gps_quality` ladder is derived from. The spec's `packages/evv/src/geofence.ts` reference
// (§3.1) resolves HERE — M18 has no `packages/evv` (it is not in the manifest `codePaths`; the pure domain
// lives in the backend module per the M6 `state-machines/` precedent). Every function is deterministic and
// IO-free, so the haversine + accuracy banding is unit-testable with no DB and no clock.
//
// The model is ADVISORY-not-block (D3 / §7.5): a geofence failure does NOT refuse the event — it stamps the
// quality band, records the snapshot, and (at the recorder, §2.4) routes to the breach-attest path. Care
// delivery is never blocked by a geofence breach.
import type { EvvEventGpsQuality } from "@wardenx/types";

/** Mean Earth radius in metres (WGS-84 spherical approximation; sufficient for sub-100m geofences). */
export const EARTH_RADIUS_M = 6_371_000;

/** §3.2 — accuracy strictly below this (metres) within the geofence is `high` quality. */
export const HIGH_ACCURACY_M = 15;

/** §2.3 — the hard accuracy ceiling (metres); a device reporting beyond this is garbage (refused upstream). */
export const ACCURACY_HARD_MAX_M = 500;

/** A WGS-84 lat/lng pair in decimal degrees. */
export interface Coordinate {
  readonly lat: number;
  readonly lng: number;
}

/** The narrowest applicable geofence policy settings (resolved in `geofence-policy.ts`). */
export interface GeofenceSettings {
  readonly radiusM: number;
  readonly maxAccuracyM: number;
}

/** The §2.2.6 pass/fail reason when an evaluation is not `inside`. */
export type GeofenceFailReason = "distance_exceeded" | "accuracy_exceeded" | "no_baseline_coordinate";

/** The geofence decision class (drives the §3.2 quality band + the §2.4 side-effect routing). */
export type GeofenceDecision = "inside" | "outside_geofence" | "no_baseline";

/**
 * The §2.2.6 informational evaluation snapshot — what was checked at recording time. The policy or address
 * may change later; this row preserves the decision (surveyor-grade). `computedDistanceM` is `null` only
 * when there is no baseline coordinate to measure against.
 */
export interface GeofenceEvaluation {
  readonly decision: GeofenceDecision;
  readonly computedDistanceM: number | null;
  readonly appliedRadiusM: number;
  readonly appliedMaxAccuracyM: number;
  readonly accuracyExceeded: boolean;
  readonly failReason: GeofenceFailReason | null;
}

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two coordinates in metres (haversine). Deterministic; the §7.1 worked
 * example — (45.5230,-122.6789)↔(45.5231,-122.6788) ≈ 14m — is asserted in the unit tests.
 */
export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Evaluate a device fix against the patient-address baseline + effective policy (§2.2.6). Returns the
 * snapshot the recorder both persists and bases its quality band on. A missing baseline coordinate (the
 * patient address was never geocoded) yields the `no_baseline` advisory decision — never a hard failure.
 */
export function evaluateGeofence(input: {
  readonly deviceCoordinate: Coordinate;
  readonly deviceAccuracyM: number;
  readonly patientAddressCoordinate: Coordinate | null;
  readonly policy: GeofenceSettings;
}): GeofenceEvaluation {
  const { deviceCoordinate, deviceAccuracyM, patientAddressCoordinate, policy } = input;
  const accuracyExceeded = deviceAccuracyM > policy.maxAccuracyM;

  if (patientAddressCoordinate === null) {
    return {
      decision: "no_baseline",
      computedDistanceM: null,
      appliedRadiusM: policy.radiusM,
      appliedMaxAccuracyM: policy.maxAccuracyM,
      accuracyExceeded,
      failReason: "no_baseline_coordinate",
    };
  }

  const computedDistanceM = haversineMeters(deviceCoordinate, patientAddressCoordinate);
  const distanceExceeded = computedDistanceM > policy.radiusM;
  // Distance is the geofence decision; accuracy beyond the policy max is surfaced separately so the recorder
  // can route it to the §3.2 `degraded_attested` retake path rather than an `outside_geofence` breach.
  const decision: GeofenceDecision = distanceExceeded ? "outside_geofence" : "inside";
  const failReason: GeofenceFailReason | null = distanceExceeded
    ? "distance_exceeded"
    : accuracyExceeded
      ? "accuracy_exceeded"
      : null;

  return {
    decision,
    computedDistanceM,
    appliedRadiusM: policy.radiusM,
    appliedMaxAccuracyM: policy.maxAccuracyM,
    accuracyExceeded,
    failReason,
  };
}

/**
 * Derive the §3.2 `evv_event_gps_quality` band from the evaluation + recording context. Precedence:
 * suspected-spoof (D9) overrides everything; then the geofence decision (`no_baseline` / `outside_geofence`);
 * then the accuracy band inside the geofence (`high` < 15m, `acceptable` ≤ policy max, `degraded_attested`
 * beyond the policy max only when the clinician attested after retakes — the recorder enforces that gate).
 */
export function deriveGpsQuality(input: {
  readonly evaluation: GeofenceEvaluation;
  readonly accuracyM: number;
  readonly degradedAttested: boolean;
  readonly spoofSuspected: boolean;
}): EvvEventGpsQuality {
  const { evaluation, accuracyM, degradedAttested, spoofSuspected } = input;
  if (spoofSuspected) return "suspected_spoof";
  if (evaluation.decision === "no_baseline") return "no_geofence_baseline";
  if (evaluation.decision === "outside_geofence") return "outside_geofence";
  // Inside the geofence.
  if (accuracyM < HIGH_ACCURACY_M) return "high";
  if (!evaluation.accuracyExceeded) return "acceptable";
  // accuracy beyond the policy max but inside the geofence → only valid once attested (recorder-enforced).
  return degradedAttested ? "degraded_attested" : "acceptable";
}

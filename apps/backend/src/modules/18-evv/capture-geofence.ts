// apps/backend/src/modules/18-evv/capture-geofence.ts — GAP-054: the capture-time geofence decision.
//
// Decided SERVER-SIDE from the haversine distance between the device fix and the patient-address baseline
// coordinate (read through M5's `PatientAddressReader` seam), against the effective policy. It used to look at
// GPS accuracy alone, let a client `degraded_attested` flag turn a failed accuracy check into a `pass`, and
// emit a hard-coded distance of 0. Now:
//   - the distance is computed, never invented: a missing baseline yields `computedDistanceM: null`;
//   - `degraded_attested` only labels the quality band of an accuracy-failed fix — it is an ADVISORY BREACH
//     (`fail_accuracy`), never a pass, and it cannot rescue a fix outside the radius;
//   - only a good-accuracy fix inside the radius is a `pass` (the only outcome that confirms the patient address).
// Advisory-not-block (D3/D4): every outcome still records the capture; this decides how it is labelled.
import type { EvvEventGpsQuality } from "@chartwarden/types";
import {
  type Coordinate,
  type GeofenceSettings,
  deriveGpsQuality,
  evaluateGeofence,
} from "./domain/geofence";

export type CaptureGeofenceDecision =
  | "pass"
  | "fail_distance"
  | "fail_accuracy"
  | "fail_no_baseline";

export interface CaptureGeofenceOutcome {
  readonly decision: CaptureGeofenceDecision;
  readonly gpsQuality: EvvEventGpsQuality;
  /** Metres from the address baseline; `null` only when there is no baseline to measure against. */
  readonly computedDistanceM: number | null;
}

export function decideCaptureGeofence(input: {
  readonly deviceCoordinate: Coordinate;
  readonly accuracyM: number;
  /** The client's `gpsQualityAttested: "degraded_attested"` claim — a label request, never a pass. */
  readonly attestedDegraded: boolean;
  readonly baseline: Coordinate | null;
  readonly policy: GeofenceSettings;
}): CaptureGeofenceOutcome {
  const evaluation = evaluateGeofence({
    deviceCoordinate: input.deviceCoordinate,
    deviceAccuracyM: input.accuracyM,
    patientAddressCoordinate: input.baseline,
    policy: input.policy,
  });
  const computedDistanceM = evaluation.computedDistanceM;
  if (evaluation.decision === "no_baseline") {
    return { decision: "fail_no_baseline", gpsQuality: "no_geofence_baseline", computedDistanceM };
  }
  if (evaluation.decision === "outside_geofence") {
    return { decision: "fail_distance", gpsQuality: "outside_geofence", computedDistanceM };
  }
  if (evaluation.accuracyExceeded) {
    return {
      decision: "fail_accuracy",
      gpsQuality: input.attestedDegraded ? "degraded_attested" : "outside_geofence",
      computedDistanceM,
    };
  }
  return {
    decision: "pass",
    gpsQuality: deriveGpsQuality({
      evaluation,
      accuracyM: input.accuracyM,
      degradedAttested: false,
      spoofSuspected: false,
    }),
    computedDistanceM,
  };
}

// apps/backend/src/modules/18-evv/domain/event-lifecycle.ts — M18-T03 (§2.2.1, §2.3, §2.4, §7.1, §7.5–§7.7).
//
// The pure §2.2.1 EVV event recorder + the §7.7 correction-of-record. An `evv_event` has no lifecycle state
// of its own — it exists or it doesn't; the VISIT's bracket state lives on M17 (driven by the outbox events
// declared here). So this is not a state machine but a validated factory: it consumes already-resolved
// cross-module context (the M17 visit via `VisitReader`/`VisitAssignmentReader`, the M5 geocoded
// patient-address coordinate via `PatientAddressReader`, the M2 `device_attestation` + the M18
// `evv_device.status`), runs the §2.3 guards, derives the §3.2 quality band, and returns the §2.4
// side-effect list DECLARATIVELY. No IO, no DB, no clock — fully unit-testable. The service/route layer
// (M18-T06) loads the context under RLS, composes the ABAC predicates, and executes the effects in one tx.
//
// The model is ADVISORY-not-block (D3): a geofence breach or a suspected spoof is RECORDED (with the breach
// reason / quality band), never refused — care delivery is never gated on the geofence (§7.5/§7.6). The hard
// guards are the integrity ones (assigned clinician, approved+attested device, coordinate sanity).
import type {
  EvvEventGpsQuality,
  EvvEventKind,
  IsoInstant,
  MembershipId,
  PatientId,
  VisitStatus,
} from "@wardenx/types";
import {
  type Coordinate,
  type GeofenceEvaluation,
  type GeofenceSettings,
  ACCURACY_HARD_MAX_M,
  deriveGpsQuality,
  evaluateGeofence,
} from "./geofence";
import { type EvvReasonField, type EvvSideEffect } from "./effects";
import { EvvStateError, require_ } from "./errors";

/** §7.5 — the minimum `geofence_breach_reason` length (chars) on an `outside_geofence` event. */
export const GEOFENCE_BREACH_REASON_MIN = 30;
/** §2.3 / §7.7 — the minimum `correction_reason` length (chars) on a correction-of-record. */
export const CORRECTION_REASON_MIN = 60;

/** §2.3 — the M17 visit statuses that accept a `check_in`. */
const CHECK_IN_VISIT_STATUSES: readonly VisitStatus[] = ["proposed", "published", "en_route"];
/** §2.3 — the M17 visit statuses that accept a `check_out`. */
const CHECK_OUT_VISIT_STATUSES: readonly VisitStatus[] = ["en_route", "in_visit"];

/** The M17 visit context the recorder validates against (resolved via the M17 reader seams; no PHI body). */
export interface VisitContext {
  readonly patientId: PatientId;
  readonly assignedMembershipId: MembershipId;
  readonly status: VisitStatus;
}

/** The device posture the recorder gates on (M18 `evv_device.status` + M2 `device_attestation.status`). */
export interface DeviceContext {
  /** The M18 `evv_device.status` — must be `approved`. */
  readonly registrationStatus: "pending_approval" | "approved" | "suspended" | "rejected" | "retired";
  /** The M2 `device_attestation.status` — must be `attested_clean`. */
  readonly attestationStatus: string;
}

/** A single check-in / check-out capture (server-side input; coordinates from the mobile fix). */
export interface CaptureInput {
  readonly kind: EvvEventKind;
  readonly postingMembershipId: MembershipId;
  readonly patientId: PatientId;
  readonly coordinate: Coordinate;
  readonly accuracyM: number;
  readonly capturedAt: IsoInstant;
  readonly recordedAt: IsoInstant;
  readonly offlineCapture: boolean;
  /** §3.2 — set when the clinician attested to a degraded fix after retakes (allows `degraded_attested`). */
  readonly degradedAttested?: boolean;
  /** §7.5 — required (≥30 chars) when the fix is `outside_geofence`. */
  readonly geofenceBreachReason?: string;
  /** §7.6 D9 — the post-write spoof heuristic verdict (advisory; recorded, never blocks). */
  readonly spoofSuspected?: boolean;
}

/** §2.4 — the check-out pairing context (resolved from the active-pair index lookup at the service layer). */
export interface CheckoutPairing {
  /** A non-superseded `check_in` exists for this visit AND it was inside the geofence. */
  readonly checkInPresentInsideGeofence: boolean;
  /** An `open` `missing_checkout` resolution exists for this visit (auto-closed on a clean check-out). */
  readonly openMissingCheckout: boolean;
}

/** The deterministic result of recording an event: the quality band, the snapshot, and the §2.4 effects. */
export interface RecordEventResult {
  readonly kind: EvvEventKind;
  readonly gpsQuality: EvvEventGpsQuality;
  readonly geofenceEvaluation: GeofenceEvaluation;
  readonly effects: readonly EvvSideEffect[];
}

function assertCaptureIntegrity(capture: CaptureInput): void {
  require_(
    Number.isFinite(capture.coordinate.lat) &&
      Number.isFinite(capture.coordinate.lng) &&
      Number.isFinite(capture.accuracyM),
    "EVV_COORDS_REQUIRED",
    "Coordinates and accuracy are required on every EVV event.",
  );
  require_(
    capture.accuracyM > 0 && capture.accuracyM <= ACCURACY_HARD_MAX_M,
    "EVV_ACCURACY_OUT_OF_RANGE",
    `accuracy_m must be > 0 and ≤ ${ACCURACY_HARD_MAX_M}.`,
  );
  require_(
    Date.parse(capture.capturedAt) <= Date.parse(capture.recordedAt),
    "EVV_CAPTURED_AFTER_RECORDED",
    "captured_at must be ≤ recorded_at (the device clock may lag the server, never lead).",
  );
}

function assertRecordingGuards(capture: CaptureInput, visit: VisitContext, device: DeviceContext): void {
  require_(
    capture.patientId === visit.patientId,
    "EVV_PATIENT_MISMATCH",
    "The event patient_id must match the M17 visit's patient.",
  );
  require_(
    capture.postingMembershipId === visit.assignedMembershipId,
    "NOT_ASSIGNED_CLINICIAN",
    "Only the visit's assigned clinician may record an EVV event.",
  );
  require_(
    device.attestationStatus === "attested_clean",
    "DEVICE_INTEGRITY_FAILED",
    "The device's M2 attestation status must be attested_clean.",
  );
  require_(
    device.registrationStatus === "approved",
    "DEVICE_NOT_APPROVED",
    "The EVV device registration must be approved.",
  );
  if (capture.kind === "check_in") {
    require_(
      CHECK_IN_VISIT_STATUSES.includes(visit.status),
      "ILLEGAL_CHECK_IN_VISIT_STATUS",
      `A check_in requires visit status ∈ {${CHECK_IN_VISIT_STATUSES.join(", ")}}.`,
    );
  } else {
    require_(
      CHECK_OUT_VISIT_STATUSES.includes(visit.status),
      "ILLEGAL_CHECK_OUT_VISIT_STATUS",
      `A check_out requires visit status ∈ {${CHECK_OUT_VISIT_STATUSES.join(", ")}}.`,
    );
  }
}

/**
 * Record a §2.2.1 check-in or check-out: run the §2.3 guards, evaluate the geofence, derive the §3.2 quality
 * band, and assemble the §2.4 side-effect list. ADVISORY-not-block: an `outside_geofence` fix records (with
 * the breach reason) and routes to the breach-attest path; it does not refuse.
 */
export function recordEvent(input: {
  readonly capture: CaptureInput;
  readonly visit: VisitContext;
  readonly device: DeviceContext;
  readonly policy: GeofenceSettings;
  readonly patientAddressCoordinate: Coordinate | null;
  /** Required for `check_out` (the active-pair index lookup); ignored for `check_in`. */
  readonly pairing?: CheckoutPairing;
}): RecordEventResult {
  const { capture, visit, device, policy, patientAddressCoordinate, pairing } = input;

  assertCaptureIntegrity(capture);
  assertRecordingGuards(capture, visit, device);

  const evaluation = evaluateGeofence({
    deviceCoordinate: capture.coordinate,
    deviceAccuracyM: capture.accuracyM,
    patientAddressCoordinate,
    policy,
  });

  const degradedAttested = capture.degradedAttested ?? false;
  const spoofSuspected = capture.spoofSuspected ?? false;

  // §3.2 — a degraded fix (accuracy beyond the policy max but inside the geofence) is only acceptable once
  // the clinician attested after retakes; otherwise the route prompts a retake (advisory, never blocks care).
  if (evaluation.decision === "inside" && evaluation.accuracyExceeded && !degradedAttested && !spoofSuspected) {
    throw new EvvStateError(
      "EVV_DEGRADED_ACCURACY_ATTESTATION_REQUIRED",
      "Fix accuracy exceeds the policy threshold; a retake attestation is required.",
    );
  }

  const gpsQuality = deriveGpsQuality({
    evaluation,
    accuracyM: capture.accuracyM,
    degradedAttested,
    spoofSuspected,
  });

  // §7.5 — an outside-geofence fix must carry a breach reason (≥30 chars); the visit still proceeds.
  if (evaluation.decision === "outside_geofence") {
    require_(
      (capture.geofenceBreachReason?.trim().length ?? 0) >= GEOFENCE_BREACH_REASON_MIN,
      "GEOFENCE_BREACH_REASON_TOO_SHORT",
      `An outside-geofence event requires a geofence_breach_reason ≥ ${GEOFENCE_BREACH_REASON_MIN} chars.`,
    );
  }

  const effects: EvvSideEffect[] = [
    { kind: "audit" },
    { kind: "insert_geofence_evaluation", evaluation },
    {
      kind: "outbox",
      event: capture.kind === "check_in" ? "m18.evv.check_in_recorded" : "m18.evv.check_out_recorded",
    },
  ];

  if (capture.geofenceBreachReason !== undefined && evaluation.decision === "outside_geofence") {
    effects.push({ kind: "capture_reason", field: "geofence_breach_reason", value: capture.geofenceBreachReason });
  }

  // §2.4 — geofence-confirmation stream M17 reads when the fix lands inside the patient address.
  if (evaluation.decision === "inside") {
    effects.push({ kind: "outbox", event: "m18.evv.at_patient_address" });
  }

  // §2.4 — an outside-geofence fix warns the supervisor and opens a missing-resolution marker (T04 machine).
  if (evaluation.decision === "outside_geofence") {
    effects.push({ kind: "outbox", event: "m18.evv.geofence_breach_recorded" });
    effects.push({ kind: "alert", alert: "geofence_breach_recorded" });
    effects.push({
      kind: "open_missing_resolution",
      resolutionKind:
        capture.kind === "check_in" ? "outside_geofence_at_checkin" : "outside_geofence_at_checkout",
    });
  }

  // §2.4 / §7.6 — a suspected-spoof fix is recorded but warned (advisory; never blocks).
  if (spoofSuspected) {
    effects.push({ kind: "outbox", event: "m18.evv.gps_spoof_suspected" });
    effects.push({ kind: "alert", alert: "gps_spoof_suspected" });
  }

  // §2.4 check-out — pair against the open check-in; a clean pair verifies the visit + auto-closes any open
  // missing-checkout resolution (system-driven). The aggregator-submission prep is M18-T06.
  if (capture.kind === "check_out") {
    const pair = pairing ?? { checkInPresentInsideGeofence: false, openMissingCheckout: false };
    if (pair.checkInPresentInsideGeofence && evaluation.decision === "inside") {
      effects.push({ kind: "outbox", event: "m18.evv.visit_verified" });
    }
    if (pair.openMissingCheckout) {
      effects.push({ kind: "close_missing_resolution_system", resolutionKind: "missing_checkout" });
    }
  }

  return { kind: capture.kind, gpsQuality, geofenceEvaluation: evaluation, effects };
}

/** The §7.7 correction-of-record input (the supervisor's supersede of an existing event). */
export interface CorrectionInput {
  readonly originalEventId: string;
  readonly originalKind: EvvEventKind;
  /** The original row's current `superseded_by_event_id` (null ⇒ it is the live head of its chain). */
  readonly originalSupersededByEventId: string | null;
  readonly newKind: EvvEventKind;
  readonly correctionReason: string;
  /** M2 step-up auth was verified fresh for `evv.event.correct` (Clinical Supervisor or above). */
  readonly stepUpVerified: boolean;
}

/** The result of a correction-of-record: the §2.4 effects (the new event id is minted by the service). */
export interface CorrectionResult {
  readonly effects: readonly EvvSideEffect[];
}

/**
 * §7.7 — file a correction-of-record: validate the supervisor's step-up + reason, refuse if the target is
 * already superseded, require the correction to keep the original kind, then declare the §2.4 effects — the
 * original row's supersede stamp (append-only), the `event_corrected` outbox event (M4 audit critical), and a
 * fresh `open` missing-resolution so the visit reverts to attestation pending (T04 machine).
 */
export function correctEvent(input: CorrectionInput): CorrectionResult {
  require_(input.stepUpVerified, "EVV_CORRECTION_STEP_UP_REQUIRED", "A correction-of-record requires M2 step-up auth.");
  require_(
    input.correctionReason.trim().length >= CORRECTION_REASON_MIN,
    "EVV_CORRECTION_REASON_TOO_SHORT",
    `correction_reason must be ≥ ${CORRECTION_REASON_MIN} chars.`,
  );
  require_(
    input.originalSupersededByEventId === null,
    "EVV_EVENT_ALREADY_SUPERSEDED",
    "The target event is already superseded; correct the live head of the chain.",
  );
  require_(
    input.newKind === input.originalKind,
    "EVV_CORRECTION_KIND_MISMATCH",
    "A correction keeps the original event's kind.",
  );

  const reasonField: EvvReasonField = "correction_reason";
  const effects: EvvSideEffect[] = [
    { kind: "audit" },
    { kind: "supersede_event", originalEventId: input.originalEventId },
    { kind: "capture_reason", field: reasonField, value: input.correctionReason },
    { kind: "outbox", event: "m18.evv.event_corrected" },
    {
      kind: "open_missing_resolution",
      resolutionKind: input.originalKind === "check_in" ? "missing_checkin" : "missing_checkout",
    },
  ];
  return { effects };
}

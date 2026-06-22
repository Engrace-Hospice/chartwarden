// apps/backend/src/modules/18-evv/domain/errors.ts — M18-T03 (§2.2.1, §2.3, §7.5, §7.7).
//
// Every guard / validation failure in the pure EVV event-lifecycle domain (the §2.2.1 append-only event
// recorder, the §2.3 validation rules, the §7.5 advisory geofence-breach attest path, the §7.7
// correction-of-record) raises an `EvvStateError` carrying the machine-readable code below. The error
// extends the M1 `WardenXError` envelope base (`@wardenx/types` — NOT the banned `packages/foundation`) so
// the M1 Fastify error handler renders it with the precise code + HTTP status with no cross-module import
// edge (the M6 `AdmissionStateError` / M17 `SchedulingStateError` convention). Nothing transitions on a
// string match — each code is an enumerated constant; the §2.3 / §3.x DB CHECK + partial-unique backstops
// (M18-T02 / 0046+0047) repeat the strongest of these at the schema layer as defense in depth. The route
// layer (M18-T06) reuses these codes verbatim.
//
// Scope note: M18-T03 added the event recorder + geofence policy/evaluation codes; M18-T04 appends the
// `evv_missing_resolution` D6 close-transition codes (≥40/≥60 reason floors, 24h/7d windows, system-actor
// guards) below. The aggregator-submission codes land in M18-T06. All share one `EvvStateError` envelope.
import { WardenXError } from "@wardenx/types";

/** The §2.2.1 / §2.3 / §7.5 / §7.7 EVV event-lifecycle + geofence failure-code catalog → HTTP status. */
export const M18_ERROR_STATUS = {
  // ── §2.3 capture integrity (DB CHECK mirrors) ─────────────────────────────────────────────────────
  // §2.3 — coordinates + accuracy are required on every event (no silent null).
  EVV_COORDS_REQUIRED: 422,
  // §2.3 — `accuracy_m > 0 AND ≤ 500` (a device reporting 1000m is reporting garbage; refuse at boundary).
  EVV_ACCURACY_OUT_OF_RANGE: 422,
  // §2.3 — `captured_at ≤ recorded_at` (the device clock may lag the server, never lead).
  EVV_CAPTURED_AFTER_RECORDED: 422,
  // §2.3 — the event's `patient_id` must match the M17 visit's patient (cross-checked at recording time).
  EVV_PATIENT_MISMATCH: 422,

  // ── §2.2.1 recording guards ──────────────────────────────────────────────────────────────────────
  // §2.2.1 / §2.3 — posting membership ≠ the M17 visit's `assigned_membership_id` (`assigned_clinician_for_visit`).
  NOT_ASSIGNED_CLINICIAN: 422,
  // §2.2.1 D8 — the M2 `device_attestation.status` is not `attested_clean`.
  DEVICE_INTEGRITY_FAILED: 422,
  // §2.3 — the `evv_device.status` is not `approved`.
  DEVICE_NOT_APPROVED: 422,
  // §2.2.1 — a `check_in` whose visit status ∉ {proposed, published, en_route}.
  ILLEGAL_CHECK_IN_VISIT_STATUS: 409,
  // §2.2.1 — a `check_out` whose visit status ∉ {en_route, in_visit}.
  ILLEGAL_CHECK_OUT_VISIT_STATUS: 409,
  // §3.2 `degraded_attested` — accuracy beyond the policy `max_accuracy_m` (but inside the geofence) without
  // the clinician's after-retake attestation; the route prompts a retake (advisory, never a hard block on care).
  EVV_DEGRADED_ACCURACY_ATTESTATION_REQUIRED: 422,
  // §7.5 — an `outside_geofence` event recorded without a `geofence_breach_reason ≥ 30 chars` (advisory-not-block).
  GEOFENCE_BREACH_REASON_TOO_SHORT: 422,

  // ── §7.7 correction-of-record ─────────────────────────────────────────────────────────────────────
  // §2.3 — the correction route requires fresh M2 step-up auth (Clinical Supervisor or above).
  EVV_CORRECTION_STEP_UP_REQUIRED: 403,
  // §2.3 — `correction_reason` shorter than the 60-char floor.
  EVV_CORRECTION_REASON_TOO_SHORT: 422,
  // §2.2.1 — the target event is already superseded; a supersede chain corrects the head, not a link.
  EVV_EVENT_ALREADY_SUPERSEDED: 409,
  // §7.7 — the correction must keep the ORIGINAL event's kind (`check_in_correction` is not an enum member).
  EVV_CORRECTION_KIND_MISMATCH: 422,

  // ── §2.2.2 / §2.3 geofence policy (three-layer, tighten-only) ──────────────────────────────────────
  // §2.3 — `radius_m` outside [50, 1000].
  GEOFENCE_RADIUS_OUT_OF_RANGE: 422,
  // §2.3 — `max_accuracy_m` outside [5, 100].
  GEOFENCE_MAX_ACCURACY_OUT_OF_RANGE: 422,
  // §2.2.2 — a narrower layer attempted to LOOSEN (larger radius / accuracy tolerance) above its parent.
  GEOFENCE_POLICY_NOT_TIGHTENING: 409,
  // §2.2.2 — a `patient_address` override without an `override_reason ≥ 30 chars`.
  GEOFENCE_OVERRIDE_REASON_TOO_SHORT: 422,
  // §2.2.2 — the resolver found no applicable layer (the platform floor row is always seeded; D-Phase-D).
  GEOFENCE_POLICY_LAYER_UNRESOLVED: 422,

  // ── §2.2.4 D6 missing-EVV resolution machine (M18-T04) ─────────────────────────────────────────────
  // §2.2.4 — the event is not accepted from the row's current status (every `closed_*` state is terminal).
  ILLEGAL_RESOLUTION_TRANSITION: 409,
  // §7.3 — a self-attest close by a membership that is not the visit's assigned clinician.
  EVV_RESOLUTION_NOT_ASSIGNED_CLINICIAN: 403,
  // §7.3 — a self-attest filed after the 24h self-attest window (must take the supervisor-override path).
  EVV_SELF_ATTEST_WINDOW_EXPIRED: 409,
  // §2.3 / §7.3 / §7.4 — the close `resolution_reason` is below the per-state floor (≥40 clinician / ≥60 supervisor).
  EVV_RESOLUTION_REASON_TOO_SHORT: 422,
  // §7.4 — a supervisor override without fresh M2 step-up auth (SESSION_POLICY for `evv.missing_resolution.supervisor_override`).
  EVV_SUPERVISOR_OVERRIDE_STEP_UP_REQUIRED: 403,
  // §7.4 — a supervisor override filed past the 7d window from the original visit.
  EVV_SUPERVISOR_OVERRIDE_WINDOW_EXPIRED: 409,
  // §2.3 — a human close (clinician / supervisor / documented-at-encounter) missing `resolved_by_membership_id`.
  EVV_RESOLVER_REQUIRED: 422,
  // §7.10 / M8 D9 — the documented-at-encounter close carries an `evv_missing_reason` below the 20-char M8 floor.
  EVV_DOCUMENTED_MISSING_REASON_TOO_SHORT: 422,
  // §2.4 — a `closed_visit_voided` close whose M17 visit is not actually cancelled.
  EVV_VISIT_NOT_CANCELLED: 409,
  // §2.4 — a system-driven close (`closed_system_checkout_received` / `closed_visit_voided`) by a non-system actor.
  EVV_RESOLUTION_SYSTEM_ACTOR_REQUIRED: 403,

  // ── §2.2.5 D7 per-state aggregator submission machine (M18-T06) ─────────────────────────────────────
  // §2.2.5 — the transition is not accepted from the row's current status (the §2.2.5 mermaid graph).
  ILLEGAL_AGGREGATOR_SUBMISSION_TRANSITION: 409,
  // §7.9 / §4.1 — a resubmit attempted from a status other than `rejected` / `timeout` (D7 resubmit-validity).
  EVV_AGGREGATOR_NOT_RESUBMITTABLE: 409,
  // §4.1 — a cancel attempted from a terminal status (D7: cancel is valid only from a non-terminal state).
  EVV_AGGREGATOR_NOT_CANCELLABLE: 409,
} as const;

/** A machine-readable M18 event-lifecycle / geofence failure code (§2.2 / §2.3). */
export type M18ErrorCode = keyof typeof M18_ERROR_STATUS;

/**
 * A guard / validation failure in the pure M18 event-lifecycle domain. Carries the precise §2.3 `code` so
 * the UI renders an exact message; the M1 error handler maps `statusCode` to the HTTP response. Per §2.2
 * every guard failure surfaces as one of these — never a raw PG exception or a generic `ConflictError`.
 */
export class EvvStateError extends WardenXError {
  constructor(code: M18ErrorCode, message: string) {
    super(code, message, M18_ERROR_STATUS[code]);
    this.name = "EvvStateError";
  }
}

/** Throw an {@link EvvStateError} when `condition` is false (guard helper). */
export function require_(condition: boolean, code: M18ErrorCode, message: string): void {
  if (!condition) throw new EvvStateError(code, message);
}

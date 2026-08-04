// @wardenx/types — Module 18 (Electronic Visit Verification) leaf contracts (M18-T01).
//
// Per ADR-0005 D1/D3 the cross-module CONTRACTS live in this leaf package: the M18 spec's references to
// `packages/evv/src/{seams,events,service-types}.ts` resolve their TYPE surface HERE so the downstream
// consumers (M8 encounter EVV-bracket close, M17 visit-state transitions, M20 field-safety live-awareness,
// M23/M24 billing EVV-compliance gate, M25 denial back-link, M30/M33 measures, M31 portal arrival surface)
// import them with no `dependsOn` edge. The runtime impls + the M1 seam-registry wiring land in M18-T05 (the
// six published reader seams); the outbox dispatch + M36 alert assembly land in M18-T07. The per-state
// `EvvAggregatorAdapter` adapter interface (§4.5 D1) lives in `@wardenx/evv-aggregators` (the §25.14
// adapter-mandate boundary), not here.
//
// M18-T01 ships the type-level surface every later M18 task builds on: the §3.2 pgEnum value mirrors, the
// §4.10 `m18.evv.*` outbox event names, the §3.6 audit denylists (the M4 trigger arguments for M18-T02), the
// §4.9 typed M36 alert payloads, the §4.3 published-seam interfaces + their read DTOs. This file is
// type-only and importable by everyone with no edge.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { OrgId, PatientId } from "./admission";
import type { IsoInstant, MembershipId } from "./care-plan";
// `VisitId` is owned by `encounter.ts` (M8) and referenced as the §2.3 logical FK on every `evv_event` —
// imported for internal use here, not re-exported (TS2308).
import type { VisitId } from "./encounter";

// ── M18-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ──────────
export type EvvEventId = string;
export type EvvDeviceId = string;
export type EvvGeofencePolicyId = string;
export type EvvGeofenceEvaluationId = string;
export type EvvMissingResolutionId = string;
export type EvvAggregatorSubmissionId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ─────────────────────

/** The §2.2.1 / D2 discrete event class (mirrors `evv_event_kind`). */
export type EvvEventKind = "check_in" | "check_out";

/** The §3.2 GPS-quality ladder stamped on every `evv_event` (mirrors `evv_event_gps_quality`). */
export type EvvEventGpsQuality =
  | "high"
  | "acceptable"
  | "degraded_attested"
  | "outside_geofence"
  | "no_geofence_baseline"
  | "suspected_spoof";

/** The §2.3 mobile platform (mirrors `evv_device_platform`). */
export type EvvDevicePlatform = "ios" | "android";

/** The §2.2.3 D8 device-registration lifecycle (mirrors `evv_device_status`). */
export type EvvDeviceStatus =
  | "pending_approval"
  | "approved"
  | "suspended"
  | "rejected"
  | "retired";

/** The §2.2.2 D3 three-layer policy scope (mirrors `evv_geofence_policy_scope`). */
export type EvvGeofencePolicyScope = "platform" | "tenant" | "patient_address";

/** The §2.2.4 D6 missing-event classification (mirrors `evv_missing_resolution_kind`). */
export type EvvMissingResolutionKind =
  | "missing_checkin"
  | "missing_checkout"
  | "outside_geofence_at_checkin"
  | "outside_geofence_at_checkout"
  | "device_integrity_failed_at_attempt";

/** The §2.2.4 D6 resolution machine (mirrors `evv_missing_resolution_status`). */
export type EvvMissingResolutionStatus =
  | "open"
  | "closed_clinician_attested"
  | "closed_supervisor_override"
  | "closed_visit_voided"
  | "closed_documented_at_encounter"
  | "closed_system_checkout_received";

/** The §2.2.5 D7 per-state aggregator submission machine (mirrors `evv_aggregator_submission_status`). */
export type EvvAggregatorSubmissionStatus =
  | "pending"
  | "queued"
  | "submitting"
  | "submitted"
  | "accepted"
  | "rejected"
  | "timeout"
  | "cancelled";

// ── §3.3 owned-table names + §3.6 audit denylist (the M4 trigger arguments for M18-T02) ───────────────

/** The six §3.3 owned tables (the manifest `ownedTables` set). */
export type M18TableName =
  | "evv_event"
  | "evv_geofence_evaluation"
  | "evv_geofence_policy"
  | "evv_device"
  | "evv_missing_resolution"
  | "evv_aggregator_submission";

/** Per-table audit denylist (§3.6, M11 D11 / M17 §3.6 pattern). Free-text PHI / encrypted ciphertext / auth
 * secrets that must NOT enter `audit_event.before/after` values — the M4 trigger records a `<changed>`
 * marker instead. Coordinate ciphertext is denylisted to avoid double-storage of the encrypted blob. */
export const M18_AUDIT_DENYLIST: { readonly [K in M18TableName]: readonly string[] } = {
  evv_event: ["coords_cipher", "accuracy_m", "correction_reason"],
  evv_geofence_evaluation: ["patient_address_coords_cipher", "device_coords_cipher"],
  evv_geofence_policy: ["override_reason"],
  evv_device: ["denial_reason", "suspend_reason", "device_key_fingerprint"],
  evv_missing_resolution: ["resolution_reason"],
  evv_aggregator_submission: [
    "payload_cipher",
    "aggregator_response_cipher",
    "aggregator_rejection_reason",
    "cancellation_reason",
  ],
} as const;

/** The M4 destruction-workflow data class for all M18 tables (§3.7). The eraser cryptographic-shreds the
 * per-tenant DEK and drops the rows (compliance retention class). Wired in M18-T05/T07. */
export const M18_DATA_CLASS = "evv_record" as const;

// ── §4.10 outbox event names (the canonical wire identifiers the dispatcher + arch:gaps validate) ─────

/** The full §4.10 M18 outbox taxonomy, in canonical `m18.evv.<verb>` form. `m18.evv.check_in_recorded`/
 * `m18.evv.check_out_recorded` close M8's `encounter.period` EVV-bracket forward seam (M8 D9) and drive the
 * M17 visit-state transitions; `m18.evv.at_patient_address` is the geofence-confirmation stream M17 reads;
 * `m18.evv.visit_verified` feeds M30 Quality. Full publication + subscription wiring lands in M18-T07. */
export const M18_EVENT_NAMES = [
  "m18.evv.check_in_recorded",
  "m18.evv.check_out_recorded",
  "m18.evv.visit_verified",
  "m18.evv.event_corrected",
  "m18.evv.geofence_breach_recorded",
  "m18.evv.at_patient_address",
  "m18.evv.gps_spoof_suspected",
  "m18.evv.late_check_out_detected",
  "m18.evv.late_check_resolved",
  "m18.evv.device_pending_approval",
  "m18.evv.device_approved",
  "m18.evv.device_suspended",
  "m18.evv.geofence_policy_changed",
  "m18.evv.aggregator_submitted",
  "m18.evv.aggregator_accepted",
  "m18.evv.aggregator_rejected",
  "m18.evv.aggregator_timeout",
  "m18.evv.aggregator_cancelled",
  "m18.evv.verification_pdf_requested",
] as const;

/** An M18 outbox event name (§4.10). */
export type M18EventName = (typeof M18_EVENT_NAMES)[number];

// ── §4.9 M36 typed alert payloads (the deterministic messages M18 emits; M36 owns delivery) ───────────
// M18-F16 (ARCH-185 / SEC-048): the fields below are for in-app rendering only; out-of-band channels (push,
// SMS) carry NO PHI — only a generic prompt + an authenticated deep-link. `patientFirstName` is first-name
// only, never full PHI, per the spec note. M36 resolves recipient PHI per permission scope.

/** The §4.9 discriminated union of every typed alert M18 emits to M36. */
export type EvvAlertPayload =
  | {
      readonly kind: "late_check_out_detected";
      readonly severity: "warn";
      readonly visitId: VisitId;
      readonly patientFirstName: string;
      readonly assignedClinicianMembershipId: MembershipId;
      readonly scheduledStartedAt: IsoInstant;
      readonly scheduledEndedAt: IsoInstant;
      readonly hoursPastGrace: number;
      readonly hasCheckIn: boolean;
    }
  | {
      readonly kind: "geofence_breach_recorded";
      readonly severity: "warn";
      readonly eventId: EvvEventId;
      readonly visitId: VisitId;
      readonly breachKind: "outside_geofence_at_checkin" | "outside_geofence_at_checkout";
      readonly computedDistanceM: number;
      readonly appliedRadiusM: number;
      readonly postingMembershipId: MembershipId;
    }
  | {
      readonly kind: "gps_spoof_suspected";
      readonly severity: "warn";
      readonly eventId: EvvEventId;
      readonly visitId: VisitId;
      readonly postingMembershipId: MembershipId;
      readonly detectionSignals: readonly string[];
    }
  | {
      readonly kind: "device_pending_approval";
      readonly severity: "info";
      readonly deviceId: EvvDeviceId;
      readonly membershipId: MembershipId;
      readonly platform: EvvDevicePlatform;
      readonly modelDescription: string;
    }
  | {
      readonly kind: "device_suspended";
      readonly severity: "warn";
      readonly deviceId: EvvDeviceId;
      readonly membershipId: MembershipId;
      readonly reason: string;
    }
  | {
      readonly kind: "aggregator_rejected";
      readonly severity: "warn";
      readonly submissionId: EvvAggregatorSubmissionId;
      readonly visitId: VisitId;
      readonly stateCode: string;
      readonly rejectionCode: string;
      readonly attemptCount: number;
    }
  | {
      readonly kind: "aggregator_timeout";
      readonly severity: "critical";
      readonly submissionId: EvvAggregatorSubmissionId;
      readonly visitId: VisitId;
      readonly stateCode: string;
      readonly attemptCount: number;
    };

// ── §4.3 published-seam read DTOs (read-only projections; never Drizzle rows) ──────────────────────────

/** §4.3 — a single EVV event projection (coordinates NEVER projected here; `evv.read_coords` is a separate
 * permission gating a distinct coordinate-read path per §4.6). */
export interface EvvEventDto {
  readonly id: EvvEventId;
  readonly organizationId: OrgId;
  readonly visitId: VisitId;
  readonly patientId: PatientId;
  readonly kind: EvvEventKind;
  readonly serviceTypeCode: string;
  readonly postingMembershipId: MembershipId;
  readonly postingDisciplineAtRecording: string;
  readonly evvDeviceId: EvvDeviceId;
  readonly capturedAt: IsoInstant;
  readonly recordedAt: IsoInstant;
  readonly gpsQuality: EvvEventGpsQuality;
  readonly offlineCapture: boolean;
  readonly replacesEventId: EvvEventId | null;
  readonly supersededByEventId: EvvEventId | null;
}

/** §4.3 — the EVV bracket M8 reads for encounter authoring + sign ("is the visit EVV-bracketed"). */
export interface EvvBracketDto {
  readonly visitId: VisitId;
  readonly checkInEvent: EvvEventDto | null;
  readonly checkOutEvent: EvvEventDto | null;
  readonly bracketState: "present" | "missing_documented" | "missing_open" | "no_evv_path";
  readonly missingResolution: EvvMissingResolutionDto | null;
}

/** §4.3 — the missing-EVV resolution projection surfaced on the visit-state-history traceability chain. */
export interface EvvMissingResolutionDto {
  readonly id: EvvMissingResolutionId;
  readonly visitId: VisitId;
  readonly kind: EvvMissingResolutionKind;
  readonly status: EvvMissingResolutionStatus;
  readonly resolvedByMembershipId: MembershipId | null;
  readonly resolvedAt: IsoInstant | null;
}

/** §4.3 — the windowed EVV-compliance aggregate M30 HQRP measures read. */
export interface EvvComplianceDto {
  readonly compliant: number;
  readonly documentedMissing: number;
  readonly unresolvedMissing: number;
  readonly notRequired: number;
  readonly total: number;
}

/** §4.3 — the last-known-location projection M20 field-safety live-awareness reads (coordinate-bearing; the
 * coordinate read is gated by `evv.location.read_team` with audit-prominence per §4.6). */
export interface EvvLocationDto {
  readonly membershipId: MembershipId;
  readonly eventId: EvvEventId;
  readonly visitId: VisitId;
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number;
  readonly capturedAt: IsoInstant;
}

/** §4.3 — the per-state aggregator submission projection M24/M25 billing reads. */
export interface EvvAggregatorSubmissionDto {
  readonly id: EvvAggregatorSubmissionId;
  readonly visitId: VisitId;
  readonly stateCode: string;
  readonly aggregatorVendor: string;
  readonly status: EvvAggregatorSubmissionStatus;
  readonly aggregatorTransactionId: string | null;
  readonly attemptCount: number;
}

// ── §4.3 seams this module publishes (impls injected at boot in M18-T05; type-checked at boot) ─────────
//
// The §4.3 `EvvBracketResolver` (M8's encounter-finalize bracket read — "is the visit EVV-bracketed") is
// NOT redefined here: M8 already leaf-typed it in `encounter.ts` (`resolveBracket` → `EvvBracketResolution`)
// as its forward seam, registered fail-closed until M18 lands. Re-declaring it here would be a TS2308
// collision; M18-T05 publishes the impl against the EXISTING `EvvBracketResolver` contract (the authority
// rule — the established cross-module contract wins over the spec's `bracketForVisit` shape). The richer
// `EvvBracketDto`/`EvvMissingResolutionDto` projections above remain available for M18's internal reads.
// The other five published seams are defined below.

/** §4.3 — the billing-gate compliance reads (M23/M24 pre-submission) + M30 HQRP measures.
 * `documented_missing` allows submission (in-encounter attestation); only `unresolved_missing` blocks
 * (ADR-0008 — EVV is never a Medicare claim gate). */
export interface EvvComplianceReader {
  bracketStateForVisit(
    orgId: OrgId,
    visitId: VisitId,
  ): Promise<"compliant" | "documented_missing" | "unresolved_missing" | "not_required">;
  complianceRateForWindow(
    orgId: OrgId,
    windowIso: { from: IsoInstant; to: IsoInstant },
    filters?: { discipline?: string },
  ): Promise<EvvComplianceDto>;
}

/** §4.3 — the aggregator transaction id back-link M24 (Medicaid claim builder) + M25 (denial) read. */
export interface EvvAggregatorReferenceReader {
  aggregatorIdForVisit(
    orgId: OrgId,
    visitId: VisitId,
  ): Promise<{
    aggregatorTransactionId: string;
    stateCode: string;
    aggregatorVendor: string;
  } | null>;
  submissionForVisit(orgId: OrgId, visitId: VisitId): Promise<EvvAggregatorSubmissionDto | null>;
}

/** §4.3 — M20 field-safety supervisor live-awareness (most recent event within last 12h). */
export interface EvvLocationProvider {
  lastKnownLocationForClinician(
    orgId: OrgId,
    membershipId: MembershipId,
  ): Promise<EvvLocationDto | null>;
  lastKnownLocationsForOrgShift(orgId: OrgId): Promise<EvvLocationDto[]>;
}

/** §4.3 — productivity + quality measures for M30 / M33 dashboards (all rates 0..1). */
export interface EvvMetricsProvider {
  getComplianceRate(orgId: OrgId, windowIso: { from: IsoInstant; to: IsoInstant }): Promise<number>;

  /**
   * The compliance population behind {@link getComplianceRate} — M30's `evv_compliance_rate` input.
   * A rate cannot drive a CMS-reportable measure: the denominator is what triggers small-N suppression,
   * and this seam is where it was being discarded (the store already tallies both).
   */
  getComplianceCounts(
    orgId: OrgId,
    windowIso: { from: IsoInstant; to: IsoInstant },
  ): Promise<{ readonly numerator: number; readonly denominator: number }>;
  getLateCheckoutRate(
    orgId: OrgId,
    windowIso: { from: IsoInstant; to: IsoInstant },
  ): Promise<number>;
  getGeofenceDeviationRate(
    orgId: OrgId,
    windowIso: { from: IsoInstant; to: IsoInstant },
  ): Promise<number>;
  getGpsSpoofingDetectedRate(
    orgId: OrgId,
    windowIso: { from: IsoInstant; to: IsoInstant },
  ): Promise<number>;
  getAggregatorSubmissionSuccessRate(
    orgId: OrgId,
    windowIso: { from: IsoInstant; to: IsoInstant },
    filters?: { stateCode?: string },
  ): Promise<number>;
  getDeviceRegistrationCoverage(
    orgId: OrgId,
  ): Promise<{ totalActiveClinicians: number; cliniciansWithApprovedDevice: number }>;
}

/** §4.3 — M31 portal arrival/verification reads (timestamp only; NO coordinates). */
export interface EvvVerificationProvider {
  arrivalEventForVisit(
    orgId: OrgId,
    visitId: VisitId,
  ): Promise<{ arrivedAt: IsoInstant; clinicianFirstName: string; discipline: string } | null>;
  visitVerificationSummaryForPortal(
    orgId: OrgId,
    visitId: VisitId,
  ): Promise<{ arrivedAt: IsoInstant; departedAt: IsoInstant; durationMinutes: number } | null>;
}

// @chartwarden/types — Module 17 (Scheduling & Route Optimization) leaf contracts (M17-T01).
//
// Per ADR-0005 D1/D3 the cross-module CONTRACTS live in this leaf package: the M17 spec's references to
// `packages/scheduling/src/{seams,events}.ts` resolve their TYPE surface HERE so the downstream consumers
// (M8 encounter-authoring context + the visit-seeding consumer, M18 EVV geofence seeding, M5 caseload
// contribution, M19 on-call triage, M20 field-safety live-awareness, M30/M33 measures, M31 portal) import
// them with no `dependsOn` edge. The runtime impls + the M1 seam-registry wiring land in M17-T05 (the four
// published reader seams); the outbox dispatch + M36 alert assembly land in M17-T08.
//
// M17-T01 ships the type-level surface every later M17 task builds on: the §3.2 pgEnum value mirrors, the
// §4.11 `m17.*` outbox event names, the §3.6 audit denylists (the M4 trigger arguments for M17-T02), the
// §4.9 typed M36 alert payloads, the §4.3 published-seam interfaces + their read DTOs. The pure-data domain
// constants (§3.2 Phase-D cancellation-reason value set, the §2.3 RRULE-subset grammar, the
// `visit_purpose → discipline` mapping the `discipline_matches_visit` predicate reads) live in the
// `@chartwarden/scheduling` FEATURE package. The OSRM `RoutingProvider` adapter interface (§4.10 D1) lives in
// `@chartwarden/routing-client`. This file is type-only and importable by everyone with no edge.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { AdmissionId, OrgId, PatientId } from "./admission";
import type { IsoInstant, LocationId, MembershipId } from "./care-plan";
// `EvvBracketState` (`evv_present` | `evv_missing_documented`) is owned by `encounter.ts` (M8) and reused as
// the §1.1 / D3 EVV-bracket flag on a visit — imported for internal use here, not re-exported (TS2308).
import type { EvvBracketState, VisitId } from "./encounter";
import type { ClinicalLinkSource } from "./clinical-link";

/** A calendar date in ISO `YYYY-MM-DD` form (org-tz service date). M17-owned alias; no other leaf exports it. */
export type IsoDate = string;

// ── M17-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @chartwarden/db) ──────────
export type VisitProposalId = string;
export type RecurringVisitId = string;
export type ClinicianAvailabilityId = string;
export type TimeOffId = string;
export type RouteSegmentId = string;
export type VisitStateHistoryId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ─────────────────────

/** The §2.2.1 / D3 reconciled (M17-F03) eight-state visit lifecycle (mirrors `visit_status`). */
export type VisitStatus =
  | "proposed"
  | "published"
  | "en_route"
  | "in_visit"
  | "completed"
  | "no_show"
  | "cancelled"
  | "rescheduled";

/** The §1.1 discipline+intent visit taxonomy (mirrors `visit_purpose`). */
export type VisitPurpose =
  | "routine_visit"
  | "prn"
  | "aide_poc"
  | "msw_assessment"
  | "msw_followup"
  | "chaplain_visit"
  | "chaplain_assessment"
  | "volunteer_visit"
  | "f2f"
  | "recert"
  | "loc_change"
  | "pronouncement"
  | "admission_visit"
  | "discharge_visit";

/** The §2.3 service-location class (mirrors `visit_setting`). */
export type VisitSetting = "patient_home" | "facility" | "inpatient_unit" | "telephonic";

/** The §2.2.4 D5 proposal lifecycle (mirrors `visit_proposal_status`). */
export type VisitProposalStatus = "pending" | "published" | "dismissed" | "stale";

/** The §2.2.4 proposal origin (mirrors `visit_proposal_source`). */
export type VisitProposalSource =
  | "frequency_driven_m7"
  | "supervisory_cadence_m15"
  | "order_required_m11"
  | "idg_decision_m14"
  // F-166 (#248, migration 0260) — M19's after-hours triage dispatch, additive-only.
  | "triage_dispatch_m19";

/** The §2.2.3 D4 recurring-policy lifecycle (mirrors `recurring_visit_status`). */
export type RecurringVisitStatus = "active" | "discontinued";

/** The §1.1 D7 PTO taxonomy (mirrors `time_off_kind`). */
export type TimeOffKind = "pto" | "sick" | "bereavement" | "training" | "other";

/** The §2.2.6 D7 approval lifecycle (mirrors `time_off_state`). */
export type TimeOffState = "requested" | "approved" | "denied" | "cancelled" | "consumed";

// The §1.1 / D3 EVV-bracket flag on a visit reuses the M8-owned `EvvBracketState`
// (`evv_present` | `evv_missing_documented`) imported above — M17 owns no distinct enum for it.

/** The §2.2.5 RRULE WEEKLY day codes (RFC 5545 subset). */
export type RruleByDay = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

// ── §3.3 owned-table names + §3.6 audit denylist (the M4 trigger arguments for M17-T02) ───────────────

/** The seven §3.3 owned tables (the manifest `ownedTables` set). */
export type M17TableName =
  | "visit"
  | "visit_state_history"
  | "recurring_visit"
  | "visit_proposal"
  | "clinician_availability"
  | "time_off"
  | "route_segment";

/** Per-table audit denylist (§3.6, M11 D11 pattern). Free-text PHI / large blobs that must NOT enter
 * `audit_event.before/after` values — the M4 trigger records a `<changed>` marker instead. Empty array =
 * structural fields only. `route_segment.polyline` is denylisted for storage savings, not privacy. */
export const M17_AUDIT_DENYLIST: { readonly [K in M17TableName]: readonly string[] } = {
  visit: [
    "scheduler_internal_notes",
    "cancellation_reason",
    "reschedule_reason",
    "no_show_reason",
    "evv_missing_reason",
    "evv_missing_resolution_reason", // F-196 (#248, mig 0269)
  ],
  visit_state_history: ["reason"],
  recurring_visit: [],
  visit_proposal: ["dismissal_reason", "source_payload"],
  clinician_availability: [],
  time_off: ["request_note", "denial_reason"],
  route_segment: ["polyline"],
} as const;

// ── §4.11 outbox event names (the canonical wire identifiers the dispatcher + arch:gaps validate) ─────

/** The full §4.11 M17 outbox taxonomy, in canonical `m17.<entity>.<verb>` form. `m17.visit.published`
 * closes M8's visit-seeding inert consumer (M8 D9); `m17.visit.assigned`/`m17.visit.unassigned` are the
 * §4.5 D11 caseload-contribution stream M5's `patientCaseloadProvider` reads; `m17.visit.late_check_out_
 * suspected` opens an M18 `evv_missing_resolution` row. Full publication + subscription wiring lands in
 * M17-T08. */
export const M17_EVENT_NAMES = [
  "m17.visit.proposed",
  "m17.visit.published",
  "m17.visit.assigned",
  "m17.visit.unassigned",
  "m17.visit.started",
  "m17.visit.completed",
  "m17.visit.cancelled",
  "m17.visit.rescheduled",
  "m17.visit.no_show_detected",
  "m17.visit.late_check_out_suspected",
  "m17.recurring_visit.discontinued",
  "m17.time_off.requested",
  "m17.time_off.approved",
  "m17.time_off.denied",
  "m17.route_optimized",
  "m17.route_optimization_degraded",
  "m17.reassignment_needed",
  "m17.stale_visit_detected",
  "m17.caregiver_reminder_due",
] as const;

/** An M17 outbox event name (§4.11). */
export type M17EventName = (typeof M17_EVENT_NAMES)[number];

// ── §4.9 M36 typed alert payloads (the deterministic messages M17 emits; M36 owns delivery) ───────────
// No free-text PHI beyond the spec-named reason fields; M36 resolves recipient PHI per permission scope.

/** The §4.9 discriminated union of every typed alert M17 emits to M36. */
export type SchedulingAlertPayload =
  | {
      readonly kind: "visit_assigned";
      readonly severity: "info";
      readonly visitId: VisitId;
      readonly clinicianMembershipId: MembershipId;
      readonly patientId: PatientId;
      readonly scheduledStartedAt: IsoInstant;
    }
  | {
      readonly kind: "visit_rescheduled";
      readonly severity: "info";
      readonly visitId: VisitId;
      readonly oldStartedAt: IsoInstant;
      readonly newStartedAt: IsoInstant;
    }
  | {
      readonly kind: "visit_cancelled";
      readonly severity: "info";
      readonly visitId: VisitId;
      readonly reason: string;
      readonly reasonCode: string;
    }
  | {
      readonly kind: "visit_no_show";
      readonly severity: "warn";
      readonly visitId: VisitId;
      readonly patientId: PatientId;
      readonly clinicianMembershipId: MembershipId;
    }
  | {
      readonly kind: "reassignment_needed";
      readonly severity: "warn";
      readonly visitId: VisitId;
      readonly reason: "pto_approved" | "clinician_credential_expired" | "volunteer_gate_expired";
      readonly affectedClinicianMembershipId: MembershipId;
    }
  | {
      readonly kind: "time_off_requested";
      readonly severity: "info";
      readonly timeOffId: TimeOffId;
      readonly requestingMembershipId: MembershipId;
      readonly conflictingVisitCount: number;
    }
  | {
      readonly kind: "time_off_approved";
      readonly severity: "info";
      readonly timeOffId: TimeOffId;
      readonly reassignmentTaskCount: number;
    }
  | {
      readonly kind: "time_off_denied";
      readonly severity: "warn";
      readonly timeOffId: TimeOffId;
      readonly reason: string;
    }
  | {
      readonly kind: "route_optimized";
      readonly severity: "info";
      readonly membershipId: MembershipId;
      readonly serviceDate: IsoDate;
      readonly totalProposedMiles: number;
      readonly totalProposedDriveMinutes: number;
    }
  | {
      readonly kind: "route_unoptimized";
      readonly severity: "warn";
      readonly membershipId: MembershipId;
      readonly serviceDate: IsoDate;
      readonly reason: "osrm_unavailable" | "no_visits";
    }
  | {
      readonly kind: "stale_visit_detected";
      readonly severity: "warn";
      readonly visitId: VisitId;
      readonly hoursStuck: number;
    }
  | {
      readonly kind: "caregiver_visit_reminder";
      readonly severity: "info";
      readonly visitId: VisitId;
      readonly patientId: PatientId;
      readonly scheduledStartedAt: IsoInstant;
      readonly channel: "sms" | "email";
    };

// ── §4.3 published-seam read DTOs (read-only projections; never Drizzle rows) ──────────────────────────

/** §4.3 — the visit read projection M8 (encounter-authoring context), M18 (EVV geofence target), M14 (IDG
 * recent-completed packet digest), and M20 (live in_visit awareness) consume. No clinical content — the
 * scheduler-internal notes are excluded from this projection (portal/metric scrubbing is the reader's job). */
export interface VisitDto {
  readonly id: VisitId;
  readonly organizationId: OrgId;
  readonly providerEntityId: string;
  readonly locationId: LocationId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly patientAddressId: string | null;
  readonly externalFacilityId: string | null;
  readonly assignedMembershipId: MembershipId;
  readonly assignedDisciplineAtAssignment: string;
  readonly visitPurpose: VisitPurpose;
  readonly visitSetting: VisitSetting;
  readonly scheduledStartedAt: IsoInstant;
  readonly scheduledEndedAt: IsoInstant;
  readonly serviceDate: IsoDate;
  readonly actualStartedAt: IsoInstant | null;
  readonly actualEndedAt: IsoInstant | null;
  readonly status: VisitStatus;
  readonly evvBracketState: EvvBracketState | null;
  readonly encounterId: string | null;
}

/** §4.3 — the caseload-contribution projection M5's `patientCaseloadProvider` reads (D11). */
export interface VisitAssignmentDto {
  readonly visitId: VisitId;
  readonly patientId: PatientId;
  readonly assignedMembershipId: MembershipId;
  readonly scheduledStartedAt: IsoInstant;
  readonly scheduledEndedAt: IsoInstant;
  readonly status: VisitStatus;
}

/** §4.3 — one on-call rotation entry in the M19 triage roster. */
export interface OnCallRosterEntry {
  readonly membershipId: MembershipId;
  readonly discipline: string;
  readonly fromIso: IsoInstant;
  readonly toIso: IsoInstant;
}

/** §4.3 — the M31 portal upcoming-visit summary (lay-language; scheduler-internal notes scrubbed). */
export interface PortalVisitSummary {
  readonly visitId: VisitId;
  readonly scheduledStartedAt: IsoInstant;
  readonly scheduledEndedAt: IsoInstant;
  readonly visitPurposeLabel: string; // lay-language; never the raw enum
  readonly clinicianDisplayName: string;
  readonly visitSetting: VisitSetting;
}

// ── §4.3 seams this module publishes (impls injected at boot in M17-T05; type-checked at boot) ─────────

/**
 * §4.3 — the patient's NEXT scheduled visit for the M36 context panel (messaging hub WP 3.1). Ids, enums and
 * instants only: no clinician identity, no free text, no scheduler-internal notes. `asOf` is the instant the
 * "next" was computed against, so a consumer can label stale data.
 */
export interface NextVisitSummary {
  readonly visitId: VisitId;
  readonly visitPurpose: VisitPurpose;
  readonly discipline: string;
  readonly scheduledStartedAt: IsoInstant;
  readonly scheduledEndedAt: IsoInstant;
  readonly status: VisitStatus;
  readonly asOf: IsoInstant;
}

/** §4.3 — visit reads for M8 (encounter context), M18 (EVV geofence target), M14 (IDG packet digest). */
export interface VisitReader extends ClinicalLinkSource {
  /** M8 encounter-authoring context. */
  visitForEncounter(orgId: OrgId, visitId: VisitId): Promise<VisitDto | null>;
  /** M18 EVV — the visits a geofence is evaluated against for a clinician's day. */
  visitsScheduledForMembershipOnDate(
    orgId: OrgId,
    membershipId: MembershipId,
    date: IsoDate,
  ): Promise<VisitDto[]>;
  /** M14 IDG — completed visits per patient since the last IDG meeting. */
  completedVisitsForPatientSince(
    orgId: OrgId,
    patientId: PatientId,
    sinceIso: IsoInstant,
  ): Promise<VisitDto[]>;
  /**
   * M36 patient context (WP 3.1) — the earliest published/en_route visit starting at/after `asOfIso`, else
   * null (none, or not visible under the org's RLS). Cancelled/completed/no-show/rescheduled/proposed never
   * qualify. Org-explicit (callable from a non-request context); throws on a blank org or unparseable asOf.
   */
  nextScheduledVisitForPatient(
    orgId: OrgId,
    patientId: PatientId,
    asOfIso: IsoInstant,
  ): Promise<NextVisitSummary | null>;
}

/** §4.3 — assignment / roster / live-awareness reads for M5 (caseload), M19 (on-call), M20 (field safety). */
export interface VisitAssignmentReader {
  /** M5 caseload contribution — window-relevant assignments for a clinician on a date. */
  activeVisitsForMembershipOnDate(
    orgId: OrgId,
    membershipId: MembershipId,
    date: IsoDate,
  ): Promise<VisitAssignmentDto[]>;
  /** M19 on-call triage — who is on which on-call rotation tonight. */
  tonightsOnCallRoster(orgId: OrgId, asOfIso: IsoInstant): Promise<OnCallRosterEntry[]>;
  /** M20 field-safety supervisor live-awareness — current in_visit per clinician. */
  currentVisitForClinician(orgId: OrgId, membershipId: MembershipId): Promise<VisitDto | null>;
}

/** §4.3 — M31 portal upcoming-visit reads (lay-language, scrubbed). */
export interface PortalVisitReader {
  upcomingForPatient(
    orgId: OrgId,
    patientId: PatientId,
    withinHours: number,
  ): Promise<PortalVisitSummary[]>;
}

/**
 * A measure population — the numerator and the DENOMINATOR it came from.
 *
 * The rate-returning methods below are fine for a dashboard tile, but M30's quality measures cannot use
 * them: `ratioResult()` collapses a measure to `insufficient_n` when the denominator is under the CMS
 * reportable floor, and that suppression IS the public-reporting rule. A rate alone cannot express it, and
 * back-computing a denominator would publish a rate CMS requires withheld. So every measure-feeding read
 * exposes the pair; the rate methods stay for the dashboard consumers that only need the number.
 */
export interface MeasureCounts {
  readonly numerator: number;
  readonly denominator: number;
}

/** §4.3 — productivity + quality measures for M30 / M33 dashboards. */
export interface VisitMetricsProvider {
  getOnTimeVisitRate(
    orgId: OrgId,
    windowIso: { from: IsoInstant; to: IsoInstant },
    filters?: { discipline?: string },
  ): Promise<number>;

  /** The on-time population behind {@link getOnTimeVisitRate} — M30's `visit_on_time_rate` input. */
  getOnTimeVisitCounts(
    orgId: OrgId,
    windowIso: { from: IsoInstant; to: IsoInstant },
    filters?: { discipline?: string },
  ): Promise<MeasureCounts>;
  getNoShowRate(orgId: OrgId, windowIso: { from: IsoInstant; to: IsoInstant }): Promise<number>;
  getRescheduleRate(orgId: OrgId, windowIso: { from: IsoInstant; to: IsoInstant }): Promise<number>;
  getRouteEfficiencyForMembership(
    orgId: OrgId,
    membershipId: MembershipId,
    windowIso: { from: IsoInstant; to: IsoInstant },
  ): Promise<{
    totalProposedMiles: number;
    totalActualMiles: number; // via M8 mileage reader
    overrideRate: number; // clinician overrode the suggested sequence
  }>;
  /** 1 − (reschedules / published). */
  getScheduleStabilityIndex(
    orgId: OrgId,
    windowIso: { from: IsoInstant; to: IsoInstant },
  ): Promise<number>;
}

// ── §4.4 seams this module CONSUMES from M15 (Discipline Care Plans, Phase 2) ──────────────────────────
//
// These two interfaces are LEAF-TYPED here (M15 owns no types file yet) so M17's pre-schedule gate (D8
// predicate 6) and day-view advisory can compile against the real contract while M15 is still Phase 2.
// Per M17-F06/ADR-0009 both register as fail-closed deny-stubs in the M1 registry until M15 ships — M17
// (Phase 1) no longer hard-requires Phase-2 M15 to boot. The volunteer gate is INVOKED only for the
// `volunteer_visit` purpose (a non-volunteer visit never calls it), so the deny-stub denies LOUDLY exactly
// when — and only when — a volunteer visit is scheduled before M15 lands. Consuming via the boot-registered
// seam adds NO `dependsOn` edge to M15 (the registry is M1-owned).

/** §4.4 / §7.4 — M15's effective volunteer-compliance status for a membership (the pre-schedule gate input). */
export interface VolunteerComplianceStatus {
  readonly membershipId: MembershipId;
  /** False if ANY required gate (TB screening, background check, training) is expired/missing. */
  readonly isActive: boolean;
  /** The specific gate keys that are unmet (e.g. `['tb_screening']`); empty when `isActive`. */
  readonly failingGates: readonly string[];
}

/** §4.4 / §7.2 — M15's next-due supervisory visit for an admission (advisory on the day view; cadence math is M15's). */
export interface SupervisoryCadence {
  readonly admissionId: AdmissionId;
  /** The org-tz service date the next RN supervisory visit is due by (≤ the §418.76(h)(1) 14-day floor). */
  readonly nextDueAt: IsoDate;
}

/**
 * §4.4 — M15-owned (Phase 2). The pre-schedule gate's predicate 6 (D8) consumes
 * `effectiveStatusFor(membershipId).isActive` for `volunteer_visit` purpose; an inactive status rejects the
 * publish/assign with `VOLUNTEER_GATE_UNMET` (42 CFR §418.78(b)). Deny-stubbed until M15 ships (M17-F06).
 */
export interface VolunteerComplianceProvider {
  effectiveStatusFor(orgId: OrgId, membershipId: MembershipId): Promise<VolunteerComplianceStatus>;
}

/**
 * §4.4 — M15-owned (Phase 2). The `propose-from-frequency` worker (D5) and the supervising RN's day view
 * read `nextSupervisoryDueAt(admissionId)` as an advisory; M17 does NOT own the cadence math (the
 * attestation lives in M15's `aide_supervisory_visit`). Returns `null` when no supervisory cadence applies.
 * Deny-stubbed until M15 ships (M17-F06).
 */
export interface SupervisoryCadenceReader {
  nextSupervisoryDueAt(orgId: OrgId, admissionId: AdmissionId): Promise<SupervisoryCadence | null>;
}

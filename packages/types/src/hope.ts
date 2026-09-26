// @wardenx/types — Module 10 (HOPE Engine) leaf contracts (M10-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package: the M10 spec's references to
// `packages/types/seams/hope.ts` resolve here — there is no domain/foundation package on the
// cross-module read path; architecture wins. M10-T01 ships the type-level surface every later M10 task +
// every cross-module consumer builds on: the §3.2 pgEnum value mirrors, the §2.4 `m10.*` outbox event
// names, the §3.1 / §8.1 audit denylists (the M4 trigger arguments for M10-T02), the §4.9 typed alert
// payloads (the builders land M10-T06), and the three §2/D10 reader seams (`HopeTimepointProvider`,
// `HopeSubmissionProvider`, `HopeJ2051Provider`) M14/M30/M32/M33 consume.
//
// The per-section TypeBox `data` discriminated unions + the J2051 evaluator live in the
// `@wardenx/hope` FEATURE package (sections land per-folder in later tasks); the seam IMPLEMENTATIONS +
// their M1-registry wiring land in M10-T05; routes in M10-T06.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so
// the package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ─
import type { AdmissionId, PatientId, ProviderEntityId } from "./admission";
import type { IsoInstant, LocationId } from "./care-plan";

// ── HOPE-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ─────────
export type HopeTimepointScheduleId = string;
export type HopeAssessmentId = string;
export type SymptomFollowUpVisitId = string;
export type HopeValidationFindingId = string;
export type HopeSubmissionId = string;
export type HopeSubmissionItemId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ────────────────────

/** The five §2 Reasons-For-Assessment a HOPE timepoint/assessment carries (mirrors `hope_rfa_kind`). */
export type HopeRfaKind = "01_admission" | "02_huv1" | "03_huv2" | "04_sfv" | "05_discharge";

/** The full ordered §2 RFA list (one entry per {@link HopeRfaKind}). */
export const HOPE_RFA_KINDS = [
  "01_admission",
  "02_huv1",
  "03_huv2",
  "04_sfv",
  "05_discharge",
] as const satisfies readonly HopeRfaKind[];

/** The Discharge-RFA branch discriminator (mirrors `hope_discharge_reason`, D9). */
export type HopeDischargeReason = "death" | "revocation" | "transfer_to_hospice" | "live_discharge";

/** The §2.2.2 lifecycle of a `hope_assessment` row (mirrors `hope_assessment_status`). */
export type HopeAssessmentStatus = "draft" | "signed" | "superseded";

/** The §2.2.1 timepoint-window lifecycle (mirrors `hope_schedule_status`). */
export type HopeScheduleStatus = "open" | "completed" | "expired" | "skipped";

/** The §2.2.3 Symptom-Follow-Up-Visit lifecycle (mirrors `hope_sfv_status`). */
export type HopeSfvStatus = "open" | "completed" | "overdue" | "missed" | "withdrawn";

/** The §2.2.4 iQIES submission-batch lifecycle (mirrors `hope_submission_status`). */
export type HopeSubmissionStatus =
  | "ready"
  | "queued"
  | "packaged"
  | "exported"
  | "in_flight"
  | "submitted_pending_result"
  | "accepted"
  | "rejected"
  | "partially_accepted"
  | "accepted_with_warnings"
  | "file_error";

/** The per-assessment outcome within a submission batch (mirrors `hope_submission_item_status`). */
export type HopeSubmissionItemStatus =
  | "accepted"
  | "accepted_with_warnings"
  | "rejected"
  | "pending"
  | "blocked"
  | "unmatched";

/** A `hope_validation_finding`'s blocking class (mirrors `hope_validation_severity`). */
export type HopeValidationSeverity = "error" | "warning";

/** The CMS four-level symptom-impact item that drives the 2-day SFV trigger (mirrors `j2051_severity`, D4). */
export type J2051Severity = "none" | "mild" | "moderate" | "severe";

/** Definition order of {@link J2051Severity} — the rank the §2.3 trigger evaluator compares against. */
export const J2051_SEVERITY_ORDER = [
  "none",
  "mild",
  "moderate",
  "severe",
] as const satisfies readonly J2051Severity[];

/** Provenance of a timepoint schedule row (mirrors `hope_schedule_generated_by`, §2). */
export type HopeScheduleGeneratedBy =
  | "auto_admission"
  | "auto_discharge"
  | "sfv_trigger"
  | "manual_admin";

// ── §3.1 / §8.1 per-entity audit denylists (the free-text/PHI columns the M4 trigger must NOT mirror) ─
// Captured here as data so M10-T02's `generateAuditTrigger(...)` denylist arguments derive from a single
// source rather than being re-typed per table. The `hope_assessment.data` jsonb carries every HOPE
// section's free-text and J-item values (PHI) and is denylisted wholesale; the structured enum/score/id
// columns are mirrored. The `clinical_context_snapshot` (PPS/ESAS-r at sign, D8) is a PHI projection and
// is denylisted; iQIES acceptance reports + per-item validation results carry patient-identifying
// findings and are denylisted from value capture (§8.1: the trigger records that a write happened, never
// the value).

/** The M10 table names that own a write-audit trigger (one per §3.3 PHI table). */
export type M10TableName =
  | "hope_timepoint_schedule"
  | "hope_assessment"
  | "symptom_follow_up_visit"
  | "hope_validation_finding"
  | "hope_submission"
  | "hope_submission_item"
  | "hope_submission_result_event";

/** Per-table audit denylist (§3.1 / §8.1). Empty array = no free-text PHI on that table. */
export const M10_AUDIT_DENYLIST: { readonly [K in M10TableName]: readonly string[] } = {
  hope_timepoint_schedule: ["alert_cadence"],
  hope_assessment: ["data", "clinical_context_snapshot", "late_completion_reason_code"],
  symptom_follow_up_visit: ["alert_cadence"],
  hope_validation_finding: ["message"],
  hope_submission: ["acceptance_report", "envelope_storage_uri", "envelope_sha256"],
  hope_submission_item: ["iqies_validation_result"],
  // The iQIES result as received and its free-text CMS message (migration 0234).
  hope_submission_result_event: ["raw_result", "message"],
} as const;

// ── §2.4 outbox event names (the canonical `m10.*` wire identifiers the dispatcher + arch:gaps validate) ─

/** The full §2.4 M10 outbox taxonomy, in canonical `m10.hope.<entity>_<verb>` form (the wire identifier
 * the M1 dispatcher publishes; the §2.4 short topics are the in-module shorthand). M33 subscribes to the
 * timepoint/J2051/submission events; M30 subscribes to `submission_accepted` for the HQRP acceptance
 * posture; M22 renders the summary PDF off `summary_requested`. The full publication lands in M10-T06. */
export const M10_EVENT_NAMES = [
  "m10.hope.timepoint_scheduled",
  "m10.hope.timepoint_signed",
  "m10.hope.timepoint_expired",
  "m10.hope.j2051_trigger_fired",
  "m10.hope.sfv_created",
  "m10.hope.sfv_completed",
  "m10.hope.sfv_overdue",
  "m10.hope.sfv_missed",
  "m10.hope.correction_submitted",
  "m10.hope.submission_queued",
  "m10.hope.submission_transmitted",
  "m10.hope.submission_accepted",
  "m10.hope.submission_rejected",
  "m10.hope.summary_requested",
] as const;

/** An M10 outbox event name (§2.4). */
export type M10EventName = (typeof M10_EVENT_NAMES)[number];

// ── §4.9 M36 typed alert payloads (the deterministic messages M10 emits; M36 doesn't re-template) ─────
// M10 emits typed alerts through M36's dispatch seam. The builders (`buildInAppPayload` /
// `buildOutOfBandPayload`, §4.9.1 PHI strip) land in `@wardenx/hope` (M10-T06); these contracts are the
// shapes M36 type-checks against. Per M10-F13 (SEC-048/ARCH-185) the PHI fields are in-app render only.

/** The §2 timepoint-window state an alert escalates through (M36 severity climbs as state advances). */
export type HopeTimepointWindowState = "opening" | "mid_window" | "closing" | "late" | "expired";

/** §4.9 — alert for an open/closing HOPE timepoint window (care-team channel + clinical lead). */
export interface HopeTimepointWindowAlert {
  readonly source: "hope_engine";
  readonly kind: "timepoint_window_state";
  readonly scheduleId: HopeTimepointScheduleId;
  readonly rfaKind: HopeRfaKind;
  readonly patientId: PatientId;
  /** PHI — in-app render only (M10-F13); stripped from out-of-band push/SMS. */
  readonly patientDisplayName: string;
  readonly windowState: HopeTimepointWindowState;
  readonly hoursUntilDeadline: number;
  /** Chart deep-link to the open form (the only field carried out-of-band). */
  readonly ctaUrl: string;
}

/** The §4.9 SFV-obligation alert state (escalates `created` → `critical_overdue`). */
export type HopeSfvAlertState = "created" | "due_tomorrow" | "overdue" | "critical_overdue";

/** §4.9 — alert for a Symptom-Follow-Up-Visit obligation. `created` is `clinical_urgent` from first
 * emission (M10-F19 / SD-015): the 2-calendar-day window is too short to defer to an escalation cron. */
export interface HopeSfvAlert {
  readonly source: "hope_engine";
  readonly kind: "sfv_obligation";
  readonly sfvId: SymptomFollowUpVisitId;
  readonly triggeringAssessmentId: HopeAssessmentId;
  readonly patientId: PatientId;
  /** PHI — in-app render only (M10-F13); stripped from out-of-band push/SMS. */
  readonly patientDisplayName: string;
  readonly state: HopeSfvAlertState;
  readonly hoursUntilDue: number;
  /** PHI — in-app render only (M10-F13); stripped from out-of-band push/SMS. */
  readonly triggeringSymptoms: ReadonlyArray<{
    readonly symptomCode: string;
    readonly severity: string;
  }>;
  readonly ctaUrl: string;
}

/** §4.9 — submission-deadline alert (compliance channel + PE admin). No patient identifier → out-of-band safe. */
export interface HopeSubmissionDeadlineAlert {
  readonly source: "hope_engine";
  readonly kind: "submission_deadline";
  readonly submissionId: HopeSubmissionId;
  readonly providerEntityId: ProviderEntityId;
  readonly itemCount: number;
  readonly daysUntilDeadline: number;
  readonly ctaUrl: string;
}

/** §4.9 — iQIES per-batch rejection alert. Rule ids are not PHI → out-of-band safe. */
export interface HopeIqiesRejectionAlert {
  readonly source: "hope_engine";
  readonly kind: "iqies_rejection";
  readonly submissionId: HopeSubmissionId;
  readonly rejectedCount: number;
  readonly topRejectionReasons: ReadonlyArray<{ readonly ruleId: string; readonly count: number }>;
  readonly ctaUrl: string;
}

/** The discriminated union of every typed alert M10 emits to M36 (§4.9). */
export type HopeAlertPayload =
  | HopeTimepointWindowAlert
  | HopeSfvAlert
  | HopeSubmissionDeadlineAlert
  | HopeIqiesRejectionAlert;

// ── §2 / D10 owned-seam read DTOs (read-only projections; never Drizzle rows) ─────────────────────────

/** The minimal who/where a HOPE row denormalizes from the admission at record-time (three-column tenancy
 * M10-F09). Carried on seam projections for PE/Location-scoped HQRP reporting. */
export interface HopeCaptureContext {
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
}

/** §D10 — one timepoint's schedule + completion state, the read M14 (open HOPE windows on the IDG
 * dashboard) + M30 (on-time rate) + M32 (decline-prediction features) consume. Resolved within the
 * caller's tenant context (RLS-scoped). */
export interface HopeTimepointStatus {
  readonly scheduleId: HopeTimepointScheduleId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly rfaKind: HopeRfaKind;
  readonly status: HopeScheduleStatus;
  readonly windowOpensAt: IsoInstant;
  readonly windowClosesAt: IsoInstant;
  readonly lateDeadlineAt: IsoInstant;
  readonly completedByAssessmentId: HopeAssessmentId | null;
  readonly generatedBy: HopeScheduleGeneratedBy;
}

/** §D10 — a J2051 trigger event for a patient (the SFV-driving symptom-impact reading), the read M30
 * (Timely Follow-Up measures) + M32 (symptom-trajectory model) consume. */
export interface HopeJ2051Event {
  readonly assessmentId: HopeAssessmentId;
  readonly sfvId: SymptomFollowUpVisitId | null;
  readonly patientId: PatientId;
  readonly maxSeverity: J2051Severity;
  readonly triggerFired: boolean;
  readonly triggeredAt: IsoInstant;
  readonly sfvDueAt: IsoInstant | null;
  readonly sfvStatus: HopeSfvStatus | null;
}

/** §D10 — a submission batch's status, the read M30 (acceptance rate) + M33 (submission dashboards)
 * consume. Keyed per ProviderEntity (HOPE is inherently per-PE; M10-F09). */
export interface HopeSubmissionStatusView {
  readonly submissionId: HopeSubmissionId;
  readonly providerEntityId: ProviderEntityId;
  readonly submissionPeriod: string;
  readonly status: HopeSubmissionStatus;
  readonly itemCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly transmittedAt: IsoInstant | null;
  readonly acceptedAt: IsoInstant | null;
}

// ── §2 / D10 seams M10 OWNS and publishes (impls + M1-registry wiring land in M10-T05) ────────────────

/**
 * §D10 — the timepoint read M30 (HOPE on-time rate / HCI) + M14 (open HOPE windows on the IDG packet) +
 * M32 (decline-prediction features) consume. `openTimepoints` returns the patient's not-yet-completed
 * windows; `forAdmission` returns the full schedule set for one admission. Resolved within the caller's
 * tenant context. Source attribution: M9 published `ScaleSeriesProvider` before M32 existed — M10
 * publishes these three seams now under the same forward-seam precedent.
 */
export interface HopeTimepointProvider {
  openTimepoints(patientId: PatientId): Promise<ReadonlyArray<HopeTimepointStatus>>;
  forAdmission(admissionId: AdmissionId): Promise<ReadonlyArray<HopeTimepointStatus>>;
}

/**
 * §D10 — the J2051 trigger read M30 (Timely Follow-Up for Pain / Non-Pain Symptom Impact) + M32
 * (symptom-trajectory model, alongside M9's `ScaleSeriesProvider`) consume. `history` returns the
 * patient's J2051 trigger events ordered by `triggeredAt`; `openSfvs` returns the not-yet-completed SFV
 * obligations. Resolved within the caller's tenant context.
 */
export interface HopeJ2051Provider {
  history(patientId: PatientId): Promise<ReadonlyArray<HopeJ2051Event>>;
  openSfvs(patientId: PatientId): Promise<ReadonlyArray<HopeJ2051Event>>;
}

/**
 * §D10 — the submission read M30 (submission-acceptance rate / APU posture) + M33 (submission
 * dashboards) consume. `latestForProviderEntity` returns the most recent batch for a PE; `submission`
 * resolves one batch by id. Resolved within the caller's tenant context.
 */
export interface HopeSubmissionProvider {
  latestForProviderEntity(
    providerEntityId: ProviderEntityId,
  ): Promise<HopeSubmissionStatusView | null>;
  submission(submissionId: HopeSubmissionId): Promise<HopeSubmissionStatusView | null>;
}

// ── ORG-LEVEL HOPE rollup seam (M30 HQRP measure-recompute consumes; aggregate-only, D6) ──────────────
//
// M10's three seams above are PER-ENTITY (patient / admission / provider-entity keyed). M30's
// `m30.measure_recompute` worker needs ORG-WIDE rolled-up COUNTS to compute the four HOPE-family measures
// (timepoint on-time, submission acceptance, SFV timeliness, J2051 timely-follow-up split pain/non-pain).
// This seam is that org-scoped aggregate, published by M10 over a dedicated Drizzle aggregate reader
// (distinct from the per-entity in-memory store). It is AGGREGATE-ONLY: every method returns COUNTS, never
// a patient row (D6 — no patient-linked HOPE content crosses to M30). Org scope is an explicit
// `organizationId` param; the Drizzle reader runs under the caller's RLS (the worker's `withOrgContext`)
// with a belt-and-suspenders `WHERE organization_id = $org` predicate too.

/**
 * The PAIN/NON-PAIN discriminator for J2051 symptom-impact triggers. The J2051 evaluator treats
 * `symptomCode` as an opaque label; PAIN is exactly this code, and any OTHER code (anxiety /
 * shortness_of_breath / nausea_vomiting / …) is NON-PAIN. This is the single correctness ASSUMPTION the
 * org-rollup's pain/non-pain split binds to — the producer's Drizzle aggregate partitions
 * `hope_assessment.data.J.J2051.entries[].symptomCode` against this constant. (M30 TFP-PI vs TFP-NPSI.)
 */
export const HOPE_J2051_PAIN_SYMPTOM_CODE = "pain";

/** The inclusive-from / exclusive-to reporting window an org-rollup method aggregates over (ISO-8601). */
export interface HopeRollupPeriod {
  readonly from: IsoInstant;
  readonly to: IsoInstant;
}

/**
 * §2 / D10 / D6 — the ORG-LEVEL HOPE rollup M30's `m30.measure_recompute` worker consumes to compute the
 * four HOPE-family HQRP measures. M10 OWNS + publishes this (registered over the deny-stub at M10 init);
 * M30 binds it via `getSeam('HopeOrgRollupProvider')`. AGGREGATE-ONLY — every method returns COUNTS, never
 * a patient row (no patient-linked HOPE content crosses, D6). The producer's Drizzle aggregate reader runs
 * under the caller's RLS, scoped additionally by the explicit `organizationId`.
 */
export interface HopeOrgRollupProvider {
  /** Timepoint-completion split for the HOPE-on-time measure: windows completed on-time vs late in the period. */
  timepointCompletionRollup(
    organizationId: string,
    period: HopeRollupPeriod,
  ): Promise<{ readonly onTime: number; readonly late: number }>;
  /** Submission posture for the acceptance measure: iQIES submissions vs those accepted in the period (APU signal). */
  submissionPostureRollup(
    organizationId: string,
    period: HopeRollupPeriod,
  ): Promise<{ readonly submissions: number; readonly acceptedSubmissions: number }>;
  /** SFV timeliness for the on-time-SFV measure: SFVs due vs completed within the 2-calendar-day window. */
  sfvTimelinessRollup(
    organizationId: string,
    period: HopeRollupPeriod,
  ): Promise<{ readonly sfvDue: number; readonly sfvOnTime: number }>;
  /**
   * J2051 timely-follow-up split for the TFP-PI / TFP-NPSI measures: qualifying (moderate-or-severe)
   * pain vs non-pain symptom-impact triggers, and how many of each had an in-window SFV. The pain/non-pain
   * partition is keyed on {@link HOPE_J2051_PAIN_SYMPTOM_CODE}.
   */
  j2051FollowUpRollup(
    organizationId: string,
    period: HopeRollupPeriod,
  ): Promise<{
    readonly painTriggers: number;
    readonly painFollowUpsInWindow: number;
    readonly nonPainTriggers: number;
    readonly nonPainFollowUpsInWindow: number;
  }>;
  /** Point-in-time count of open (not-yet-completed) SFV obligations for the org (the survey-readiness signal). */
  openSfvObligationCount(organizationId: string): Promise<number>;
}

/**
 * §2.4 — internal marker the M1 outbox dispatcher uses to type-check M10 subscribers. M10 performs no
 * direct cross-module writes at the boundary; all downstream communication is the `m10.*` outbox.
 */
export type HopeEventPublisher = Record<string, never>;

// @wardenx/types — Module 9 (Clinical Assessments Suite) leaf contracts (M9-T01).
//
// Per ADR-0005 D1/D2 (finding M09-F01) the cross-module CONTRACTS live in this leaf package: the M9
// spec's references to `packages/types/seams/assessments.ts` + `packages/domain/assessments/*`
// resolve here — there is no domain/foundation package on the cross-module read path; architecture
// wins. M9-T01 ships the type-level surface every later M9 task + every cross-module consumer builds
// on: the §3.2 pgEnum value mirrors, the §2.2 / §2.4 significant-change rule taxonomy + the
// CRITICAL_RULES floor (§4.9), the §3.1 / §8.1 audit denylists (the M4 trigger arguments for
// M9-T02/T03), the §2.4 `m9.*` outbox event names, the §4.9 typed alert payload, and the two §4.7
// reader seams (`LatestAssessmentProvider`, `ScaleSeriesProvider`) M7/M10/M14/M22/M28/M32 consume.
//
// The per-scale `data` discriminated unions + scoring live in the `@wardenx/assessments` FEATURE
// package (M9-T03); the seam IMPLEMENTATIONS + their M1-registry wiring land in M9-T04; routes in
// M9-T05; the full outbox publication in M9-T06.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so
// the package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ─
import type { AdmissionId, DateRange, OrgId, PatientId, ProviderEntityId } from "./admission";
import type { IsoInstant, LocationId, MembershipId } from "./care-plan";

// ── Assessment-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ──
export type ClinicalAssessmentId = string;
export type AssessmentCosignatureId = string;
export type SignificantChangeEventId = string;
export type ScaleLicenseId = string;
export type ScalePolicyId = string;
/** A M8 encounter id (logical/soft-ref; D5 — nullable until M8 backfills `source_encounter_id`). */
export type SourceEncounterId = string;
/** A M39 consent id carried when the reporter is a DPOA agent (`acting_as='patient_representative'`). */
export type ActingConsentId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ────────────────────

/** The 14 §1.1 validated instruments a `clinical_assessment` row may carry (mirrors `scale_type`, D1). */
export type ScaleType =
  | "pps"
  | "kps"
  | "fast"
  | "painad"
  | "flacc"
  | "esas_r"
  | "nyha"
  | "meld"
  | "bode"
  | "flacker"
  | "gds"
  | "braden"
  | "morse"
  | "aims";

/** The full ordered §3.2 scale list (the SCALE_CATALOG key set; one entry per {@link ScaleType}). */
export const SCALE_TYPES = [
  "pps",
  "kps",
  "fast",
  "painad",
  "flacc",
  "esas_r",
  "nyha",
  "meld",
  "bode",
  "flacker",
  "gds",
  "braden",
  "morse",
  "aims",
] as const satisfies readonly ScaleType[];

/**
 * The five proprietary scales whose recording is license-gated (D3): without an `active`
 * `scale_license` the form is hidden and the write is refused (`SCALE_LICENSE_MISSING`). Reads of
 * historical rows recorded under a prior active license are preserved.
 */
export const LICENSED_SCALE_TYPES = ["pps", "fast", "gds", "braden", "morse"] as const;
/** A {@link ScaleType} that requires an active license to record (D3). */
export type LicensedScaleType = (typeof LICENSED_SCALE_TYPES)[number];

/** The §2.2.1 lifecycle of a `clinical_assessment` row (mirrors `assessment_status`, D9). */
export type AssessmentStatus = "active" | "superseded";

/** Whether the reporter is the patient or an attributed representative (mirrors `assessment_acting_as`). */
export type AssessmentActingAs = "self" | "patient_representative";

/** The §2.4 threshold-crossing rules the significant-change detector evaluates (mirrors
 * `significant_change_rule_id`, D2). */
export type SignificantChangeRuleId =
  | "pps_drop_20_in_14d"
  | "kps_drop_20_in_14d"
  | "esas_total_increase_20_in_7d"
  | "esas_symptom_ge_7"
  | "painad_ge_4"
  | "nyha_class_iv"
  | "braden_le_12"
  | "morse_ge_51"
  | "meld_ge_30"
  | "fast_progression_30d"
  | "gds_progression_30d"
  | "flacker_increase"
  | "aims_emergent_dyskinesia";

/** The §2.2.2 ack lifecycle for a detected significant change (mirrors `significant_change_status`). */
export type SignificantChangeStatus = "open" | "acknowledged" | "escalated";

/** The §2.2.3 per-tenant licensure state for a proprietary scale (mirrors `scale_license_status`, D3). */
export type ScaleLicenseStatus = "active" | "pending_renewal" | "expired";

// ── §4.9 / M09-F12 significant-change severity floor (declared as data) ──────────────────────────────

/** The per-alert severity the significant-change detector assigns (§4.9). `clinical_urgent` is set at
 * first emission for {@link CRITICAL_RULES}; `medium` for all other rules at first emission; `high`
 * after a 24h no-ack escalation (§2.2.2; the change-escalation cron, M9-T06). */
export type AssessmentAlertSeverity = "clinical_urgent" | "medium" | "high";

/**
 * §4.9 / M09-F12 / ARCH-184 — the rules designated CRITICAL: they route at `clinical_urgent` on FIRST
 * emission (the medical-director inbox is notified immediately, not only on escalation) because each is
 * a prognosis-altering finding that requires clinical-supervisor visibility before the next check-in.
 */
export const CRITICAL_RULES = [
  "pps_drop_20_in_14d", // prognosis-altering decline
  "braden_le_12", // imminent pressure-injury risk
  "nyha_class_iv", // end-stage cardiac
] as const satisfies readonly SignificantChangeRuleId[];

/** §4.9 — whether a rule is CRITICAL (emits `clinical_urgent` at first emission). */
export function isCriticalRule(ruleId: SignificantChangeRuleId): boolean {
  return (CRITICAL_RULES as readonly SignificantChangeRuleId[]).includes(ruleId);
}

// ── §3.1 / §8.1 per-entity audit denylists (the free-text/PHI columns the M4 trigger must NOT mirror) ─
// Captured here as data so M9-T02/T03's `generateAuditTrigger(...)` denylist arguments derive from a
// single source rather than being re-typed per table. The free-text `notes`/clinical-narrative columns
// (in the `data` jsonb) and the ESAS-r `otherSymptomText` are denylisted from value capture (§8.1: the
// trigger records that a write happened + a `<changed>` marker, never the PHI value). Structured
// numerics, enums, ids, scores, and boilerplate attestation text are kept (the M8 convention). The
// `clinical_assessment.data` jsonb is denylisted wholesale — it carries per-scale free-text.

/** The M9 table names that own a write-audit trigger (one per §3.3 owned table). */
export type M9TableName =
  | "clinical_assessment"
  | "assessment_cosignature"
  | "significant_change_event"
  | "scale_license"
  | "scale_policy";

/** Per-table audit denylist (§3.1 / §8.1). Empty array = no free-text PHI on that table. */
export const M9_AUDIT_DENYLIST: { readonly [K in M9TableName]: readonly string[] } = {
  // `data` carries every scale's free-text `notes` + the ESAS-r `otherSymptomText` (PHI); the structured
  // score/interpretation columns are mirrored, the jsonb payload is not.
  clinical_assessment: ["data", "correction_reason"],
  assessment_cosignature: ["attestation_text"],
  significant_change_event: ["acknowledgment_note"],
  scale_license: [],
  scale_policy: [],
} as const;

// ── §2.4 outbox event names (the `m9.*` namespace the dispatcher + arch:gaps catalog validate) ────────

/** The full §2.4 M9 outbox taxonomy, in subscriber-facing `m9.*` form. The system keys off
 * `m9.assessment.recorded` (M7/M14/M28/M30/M33), the `m9.assessment.significant_change` chain
 * (M36/M7/M11/M14), and the daily `m9.scale.license_*` worker events (M36/M33). The full publication
 * lands in M9-T06. */
export const M9_EVENT_NAMES = [
  "m9.assessment.recorded",
  "m9.assessment.amended",
  "m9.assessment.significant_change",
  "m9.assessment.significant_change_acknowledged",
  "m9.assessment.significant_change_escalated",
  "m9.assessment.summary_requested",
  "m9.scale.license_pending_renewal",
  "m9.scale.license_lapsed",
  "m9.scale.policy_changed",
] as const;

/** An M9 outbox event name (§2.4). */
export type M9EventName = (typeof M9_EVENT_NAMES)[number];

// ── §4.9 M36 typed alert payload (the deterministic message M9 emits; M36 doesn't re-template) ────────

/**
 * §4.9 — the typed alert M36 receives when `m9.assessment.significant_change` fires. Severity is
 * assigned at first emission by the detector (§4.9 / M09-F12): {@link CRITICAL_RULES} → `clinical_urgent`
 * (medical director notified immediately); all other rules → `medium`, upgradable to `high` after 24h
 * without ack (the change-escalation cron). The `recipients` block declares the fan-out M36 resolves.
 */
export interface AssessmentSignificantChangeAlert {
  readonly kind: "m9.assessment.significant_change";
  readonly organizationId: OrgId;
  readonly patientId: PatientId;
  readonly assessmentId: ClinicalAssessmentId;
  readonly ruleId: SignificantChangeRuleId;
  readonly scaleType: ScaleType;
  readonly severity: AssessmentAlertSeverity;
  readonly deltaValue: number | null;
  readonly thresholdValue: number | null;
  readonly recipients: {
    readonly careTeamChannel: true;
    readonly caseManagerInbox: true;
    readonly clinicalSupervisorInbox: true;
    /** `clinical_urgent`: immediate; `high`: on escalation; `medium`: never (supervisor already in the channel). */
    readonly medicalDirectorInbox: "immediate" | "on_escalation" | false;
  };
  /** The deterministic message M9 emits; M36 delivers it verbatim (§4.9). */
  readonly bodyTemplate: string;
}

// ── §4.7 / D7 owned-seam DTOs (read-only projections; never Drizzle rows) ─────────────────────────────

/** The minimal who/where a captured assessment denormalizes from the admission at record-time (§3.3,
 * three-column tenancy M09-F03). Carried on every seam projection for PE/Location-scoped reporting. */
export interface AssessmentCaptureContext {
  readonly capturedByMembershipId: MembershipId;
  readonly capturedByDiscipline: string;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
}

/**
 * §4.7 — the latest active assessment of one scale for a patient, the hot read powering the CTI
 * narrative draft (M6) + IDG packet (M14) + HOPE prognosis context (M10). `score`/`interpretation` are
 * the server-computed canonical values; `redacted` is true when SUD content (AIMS) was filtered for the
 * caller (D10 disclosure gate). Resolved within the caller's tenant context (RLS-scoped).
 */
export interface LatestAssessment {
  readonly assessmentId: ClinicalAssessmentId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly scaleType: ScaleType;
  readonly scaleVersion: string;
  readonly score: number | null;
  readonly scoreInterpretation: string | null;
  readonly capturedAt: IsoInstant;
  readonly capture: AssessmentCaptureContext;
  readonly sourceEncounterId: SourceEncounterId | null;
  readonly cosignRequired: boolean;
  readonly cosignedAt: IsoInstant | null;
  readonly status: AssessmentStatus;
  readonly redacted: boolean;
}

/** One point in a {@link ScaleSeries} (§4.3 `SeriesPointDto`): a scored capture with a
 * significant-change marker, ordered by `capturedAt`. */
export interface ScaleSeriesPoint {
  readonly assessmentId: ClinicalAssessmentId;
  readonly capturedAt: IsoInstant;
  readonly score: number | null;
  readonly scoreInterpretation: string | null;
  readonly significantChange: boolean;
}

/** A windowed series of one scale for a patient (§4.3 `SeriesResponseDto`); read-time computed (D4). */
export interface ScaleSeries {
  readonly scaleType: ScaleType;
  readonly patientId: PatientId;
  readonly from: IsoInstant;
  readonly to: IsoInstant;
  readonly points: ReadonlyArray<ScaleSeriesPoint>;
}

/** A latest-vs-window delta for one scale (§4.1 `/scales/:scaleType/delta`). `null` when fewer than two
 * comparable captures exist in the window. */
export interface ScaleDelta {
  readonly scaleType: ScaleType;
  readonly patientId: PatientId;
  readonly window: DateRange;
  readonly latestScore: number | null;
  readonly priorScore: number | null;
  readonly delta: number | null;
}

// ── §4.7 / D7 seams M9 OWNS and publishes (impls + M1-registry wiring land in M9-T04) ─────────────────

/**
 * §4.7 / D7 — the hot "give me the latest PPS/FAST/ESAS-r right now" read M7 (CTI narrative draft) +
 * M10 (HOPE prognosis) + M14 (IDG packet) consume synchronously. Returns the latest `active` row per
 * (patient, scale); `latestBatch` resolves several scales for one patient in a single call (the
 * `/internal/assessments/latest-batch` route). Resolved within the caller's tenant context.
 */
export interface LatestAssessmentProvider {
  latest(patientId: PatientId, scaleType: ScaleType): Promise<LatestAssessment | null>;
  latestBatch(
    patientId: PatientId,
    scaleTypes: ReadonlyArray<ScaleType>,
  ): Promise<ReadonlyArray<LatestAssessment>>;
}

/**
 * §4.7 / D7 — the trend read surface M14 (IDG packet deltas) + M28 (FHIR `Observation` series) + M32
 * (AI symptom-trajectory) consume. `series` returns the windowed scored captures (read-time computed,
 * D4); `delta` returns the latest-vs-window change. Resolved within the caller's tenant context.
 */
export interface ScaleSeriesProvider {
  series(
    patientId: PatientId,
    scaleType: ScaleType,
    from: IsoInstant,
    to: IsoInstant,
  ): Promise<ScaleSeries>;
  delta(patientId: PatientId, scaleType: ScaleType, window: DateRange): Promise<ScaleDelta>;
}

/**
 * §2.4 — internal marker the M1 outbox dispatcher uses to type-check M9 subscribers. M9 performs no
 * direct cross-module writes at the boundary; all downstream communication is the `m9.*` outbox.
 */
export type AssessmentEventPublisher = Record<string, never>;

// @wardenx/types — Module 13 (eMAR & Med Administration) leaf contracts (M13-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package: the M13 spec's references to
// `packages/domain/administration/seams.ts` (the §2.12 D16 `MedicationAdministrationProvider` /
// `ReconciliationProvider`), the §4.9 typed M36 alert payloads, and the §4.4 `m13.*` outbox event names
// resolve their TYPE surface HERE so downstream consumers (M14 IDG, M21 comfort-kit, M28 FHIR, M30 measures,
// M31 portal, M33 metrics, M36 alerts) import them with no `dependsOn` edge. The runtime impls + the M1
// seam-registry wiring land later (the providers in M13-T07, the alert/outbox assemblers in M13-T08).
//
// M13-T01 ships the type-level surface every later M13 task builds on: the §3.2 pgEnum value mirrors, the
// §4.4 `m13.*` outbox event names, the §7.6 / §3.6 audit denylists (the M4 trigger arguments for M13-T02),
// the §4.9 typed alert payloads, the §2.12 owned-seam interfaces + read DTOs, and the FHIR/portal read
// projections. The §2.1 per-mode `ADMINISTRATION_MODE_CATALOG` metadata + the pure lifecycle machines /
// schedule-parser / five-rights validators live in the `@wardenx/emar` FEATURE package. This file is
// type-only and importable by everyone with no edge.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { PatientId, AdmissionId } from "./admission";
import type { IsoInstant } from "./care-plan";

// ── M13-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ──────────
export type AdministrationRecordId = string;
export type ScheduledDoseId = string;
export type PrnAdministrationId = string;
export type MissedDoseId = string;
export type AdministrationWitnessId = string;
export type ComfortKitDeploymentId = string;
export type ComfortKitDrawdownId = string;
export type ReconciliationWorksheetId = string;
export type ReconciliationDecisionId = string;
export type BarcodeScanEventId = string;
export type AdministrationOfflineQueueId = string;
export type AdministrationPolicyId = string;
/** An IV-continuous session correlation id (minted by `iv_continuous_start`, §2.1). */
export type IvSessionId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ─────────────────────

/** The §2.1 six administration modes (mirrors `administration_mode`). */
export type AdministrationMode =
  | "single_dose"
  | "iv_continuous_start"
  | "iv_continuous_rate_change"
  | "iv_continuous_pause"
  | "iv_continuous_resume"
  | "iv_continuous_stop";

/** The §2.2 D6 PERSISTED lifecycle status (mirrors `administration_status`; the transient `committing` /
 * synthetic `pending_offline_sync` states are never written and so are not part of the enum). */
export type AdministrationStatus =
  | "committed"
  | "pending_caregiver_review"
  | "superseded"
  | "voided";

/** Who recorded the administration (mirrors `administration_actor_kind`). */
export type AdministrationActorKind =
  | "clinician"
  | "caregiver_attested"
  | "system_iv_session_event";

/** The §2.5 D8 late-entry tier (mirrors `administration_late_entry_tier`). */
export type AdministrationLateEntryTier =
  | "normal"
  | "late"
  | "significant_late"
  | "administrative_override";

/** The §2.3 D2 materialized-schedule row state (mirrors `scheduled_dose_status`). */
export type ScheduledDoseStatus =
  | "pending"
  | "administered"
  | "missed"
  | "cancelled"
  | "intentionally_held";

/** Why a future scheduled dose was cancelled (mirrors `scheduled_dose_cancellation_reason`). */
export type ScheduledDoseCancellationReason =
  | "order_discontinued"
  | "admission_discharged"
  | "corrected_replacement"
  | "tenant_policy";

/** How a missed dose arose (mirrors `missed_dose_kind`). */
export type MissedDoseKind = "detected_by_sweep" | "intentionally_held" | "patient_refused";

/** The §2.6 D7 controlled-substance witness presence mode (mirrors `administration_witness_kind`). */
export type AdministrationWitnessKind = "co_present" | "telephonic";

/** What the witness attested (mirrors `administration_witnesses_scope`). */
export type AdministrationWitnessesScope =
  | "administration_only"
  | "wastage_only"
  | "administration_and_wastage";

/** The §2.4 D3 PRN trigger provenance (mirrors `prn_requested_by_kind`). */
export type PrnRequestedByKind =
  | "clinician_observed"
  | "patient_request"
  | "caregiver_request"
  | "scheduled_reassessment_protocol";

/** The M6 event that opened the worksheet (mirrors `reconciliation_trigger_kind`). */
export type ReconciliationTriggerKind =
  | "admission"
  | "transfer_in"
  | "discharge"
  | "recertification";

/** The §2.8 worksheet lifecycle (mirrors `reconciliation_worksheet_status`). */
export type ReconciliationWorksheetStatus =
  | "pending"
  | "in_progress"
  | "finalized"
  | "voided";

/** The §2.8 per-line reconciliation decision (mirrors `reconciliation_decision_kind`). */
export type ReconciliationDecisionKind =
  | "carry_forward"
  | "discontinue"
  | "hold"
  | "new_order"
  | "document_only";

/** The §2.7 D5 deployment disposal lifecycle (mirrors `comfort_kit_disposal_status`). */
export type ComfortKitDisposalStatus =
  | "deployed"
  | "return_required"
  | "returned"
  | "disposed_unreturned";

/** The §2.7 replenishment-needed urgency (mirrors `comfort_kit_replenishment_urgency`). */
export type ComfortKitReplenishmentUrgency = "routine" | "urgent";

/** The §2.10 D18 server-side offline-queue ingest state (mirrors `offline_sync_status`). */
export type OfflineSyncStatus = "pending" | "synced" | "rejected";

// ── §7.6 / §3.6 per-entity audit denylists (the free-text/PHI columns the M4 trigger must NOT mirror, D12)
// Captured here as data so M13-T02's `audit_install_trigger(...)` denylist arguments derive from a single
// source. Top-level free-text columns are denylisted by name; the per-mode free text inside
// `administration_record.data` (`sig_free_text`, `infusionDilution`, `titrationReason`, `pauseReason`,
// `stopReason`, `wastageReason`) is denylisted via the `data->>...` json-path form per §3.6, and the
// `caregiver_reported_snapshot` jsonb is denylisted whole. The trigger records that a write happened, never
// the value.

/** The M13-owned table names that carry an M4 write-audit trigger (one per manifest `ownedTables`). */
export type M13TableName =
  | "administration_record"
  | "scheduled_dose"
  | "prn_administration"
  | "missed_dose"
  | "administration_witness"
  | "comfort_kit_deployment"
  | "comfort_kit_drawdown"
  | "medication_reconciliation_worksheet"
  | "medication_reconciliation_decision"
  | "barcode_scan_event"
  | "administration_offline_queue"
  | "administration_policy";

/** Per-table audit denylist (§3.6 / §7.6). Empty array = no free-text/PHI column on that table (structural
 * fields only). The `data->>...` entries are json-path denylists of per-mode free-text inside the jsonb. */
export const M13_AUDIT_DENYLIST: { readonly [K in M13TableName]: readonly string[] } = {
  administration_record: [
    "notes",
    "refusal_reason",
    "caregiver_attestation_text",
    "dispute_reason",
    "administrative_override_reason",
    "correction_reason",
    "void_reason",
    "caregiver_reported_snapshot",
    "data->>sig_free_text",
    "data->>infusionDilution",
    "data->>titrationReason",
    "data->>pauseReason",
    "data->>stopReason",
    "data->>wastageReason",
  ],
  scheduled_dose: [],
  prn_administration: ["triggering_prn_reason", "prn_interval_override_reason"],
  missed_dose: ["missed_reason"],
  administration_witness: [],
  comfort_kit_deployment: [],
  comfort_kit_drawdown: ["notes"],
  medication_reconciliation_worksheet: [],
  medication_reconciliation_decision: ["decision_notes"],
  barcode_scan_event: [],
  administration_offline_queue: ["rejection_reason_detail"],
  administration_policy: [],
} as const;

// ── §4.4 outbox event names (the canonical `m13.*` wire identifiers the dispatcher + arch:gaps validate) ─

/** The full §4.4 M13 outbox taxonomy, in canonical `m13.<entity>.<verb>` / `m13.<entity>_<verb>` form (the
 * wire identifier the M1 dispatcher publishes). M9 consumes the PRN-reassessment trigger; M14 the IDG-
 * relevant events; M21 the comfort-kit replenishment/return signals; M22 the form-render handshake events;
 * M28 the FHIR-projection events; M30 the survey-evidence + measure stream; M31 the portal stream; M33 the
 * metrics stream; M36 the typed alerts. The full publication + subscription wiring lands in M13-T08. */
export const M13_EVENT_NAMES = [
  "m13.administration.recorded",
  "m13.administration.controlled_witnessed",
  "m13.administration.controlled_wasted",
  "m13.administration.refused",
  "m13.administration.corrected",
  "m13.administration.voided",
  "m13.administration.recorded_caregiver_attested",
  "m13.caregiver_administration.acknowledged",
  "m13.caregiver_administration.disputed",
  "m13.prn_administration_recorded",
  "m13.scheduled_dose.materialized",
  "m13.scheduled_dose.missed",
  "m13.scheduled_dose.cancelled",
  "m13.scheduled_dose.intentionally_held",
  "m13.missed_dose.acknowledged",
  "m13.missed_dose.reverted",
  "m13.reconciliation.opened",
  "m13.reconciliation.due_at_warning",
  "m13.reconciliation.overdue",
  "m13.reconciliation.draft_order_requested",
  "m13.reconciliation.discontinue_requested",
  "m13.reconciliation.completed",
  "m13.reconciliation.voided",
  "m13.comfort_kit.deployed",
  "m13.comfort_kit.replenishment_needed",
  "m13.comfort_kit.return_required",
  "m13.comfort_kit.returned",
  "m13.comfort_kit.return_overdue",
  "m13.comfort_kit.controlled_substance_discrepancy",
  "m13.administration_record.document_requested",
  "m13.reconciliation.document_requested",
  "m13.policy.changed",
] as const;

/** An M13 outbox event name (§4.4). */
export type M13EventName = (typeof M13_EVENT_NAMES)[number];

// ── §4.9 M36 typed alert payloads (the deterministic messages M13 emits; M36 doesn't re-template) ─────
// M13 emits typed alerts through M36's dispatch seam. The builders land in `@wardenx/emar` (M13-T08); this
// discriminated union is the shape M36 type-checks against. No PHI in the payloads — only IDs + structural
// facts; M36 resolves PHI per recipient permission scope (§4.9).

/** The §4.9 discriminated union of every typed alert M13 emits to M36. */
export type M13AlertPayload =
  | {
      readonly alertKind: "m13.missed_dose";
      readonly patientId: PatientId;
      readonly medicationOrderId: string;
      readonly drugName: string;
      readonly dueAt: string;
      readonly isControlled: boolean;
      readonly severity: "routine" | "high";
    }
  | {
      readonly alertKind: "m13.missed_dose_overdue_unack";
      readonly patientId: PatientId;
      readonly missedDoseId: MissedDoseId;
      readonly hoursUnacknowledged: number;
      readonly severity: "high";
    }
  | {
      readonly alertKind: "m13.controlled_substance_admin_anomaly";
      readonly patternKind: "frequent_wastage" | "inventory_discrepancy";
      readonly summary: string;
      readonly severity: "high";
    }
  | {
      readonly alertKind: "m13.caregiver_attested_pending_review";
      readonly administrationRecordId: AdministrationRecordId;
      readonly patientId: PatientId;
      readonly drugName: string;
      readonly recordedAt: string;
      readonly severity: "routine";
    }
  | {
      readonly alertKind: "m13.caregiver_attested_disputed";
      readonly administrationRecordId: AdministrationRecordId;
      readonly patientId: PatientId;
      readonly disputeBy: string;
      readonly disputeAt: string;
      readonly severity: "high";
    }
  | {
      readonly alertKind: "m13.comfort_kit_replenishment_routine";
      readonly deploymentId: ComfortKitDeploymentId;
      readonly drugName: string;
      readonly remainingQuantity: number;
      readonly requestedQuantity: number;
      readonly severity: "routine";
    }
  | {
      readonly alertKind: "m13.comfort_kit_replenishment_urgent";
      readonly deploymentId: ComfortKitDeploymentId;
      readonly drugName: string;
      readonly remainingQuantity: number;
      readonly requestedQuantity: number;
      readonly severity: "high";
    }
  | {
      readonly alertKind: "m13.comfort_kit_return_required";
      readonly deploymentId: ComfortKitDeploymentId;
      readonly patientId: PatientId;
      readonly dischargeReason: string;
      readonly severity: "routine";
    }
  | {
      readonly alertKind: "m13.comfort_kit_return_overdue";
      readonly deploymentId: ComfortKitDeploymentId;
      readonly daysOverdue: number;
      readonly severity: "high";
    }
  | {
      readonly alertKind: "m13.comfort_kit_controlled_discrepancy";
      readonly deploymentId: ComfortKitDeploymentId;
      readonly drugName: string;
      readonly deltaQuantity: number;
      readonly deltaPercent: number;
      readonly severity: "high";
    }
  | {
      readonly alertKind: "m13.reconciliation_overdue";
      readonly worksheetId: ReconciliationWorksheetId;
      readonly patientId: PatientId;
      readonly triggerKind: ReconciliationTriggerKind;
      readonly overdueHours: number;
      readonly severity: "high";
    }
  | {
      readonly alertKind: "m13.administration_voided";
      readonly administrationRecordId: AdministrationRecordId;
      readonly voidReason: string;
      readonly voidedBy: string;
      readonly severity: "high";
    };

// ── §2.12 D16 owned-seam read DTOs (read-only projections; never Drizzle rows) ────────────────────────

/** §2.12 — one administration's read projection. The hot path every downstream consumer reads. The
 * denormalized `*Snapshot` fields are server-resolved at row commit (drug name / RxNorm / route / dose). */
export interface AdministrationDto {
  readonly id: AdministrationRecordId;
  readonly organizationId: string;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly medicationOrderId: string; // resolved through M12
  readonly scheduledDoseId: ScheduledDoseId | null;
  readonly prnAdministrationId: PrnAdministrationId | null;
  readonly encounterId: string | null;
  readonly comfortKitDeploymentId: ComfortKitDeploymentId | null;
  readonly ivSessionId: IvSessionId | null;
  readonly mode: AdministrationMode;
  readonly administeredAt: IsoInstant; // clinician-entered
  readonly recordedAt: IsoInstant; // server-receive
  readonly administeringClinicianMembershipId: string | null; // null only for caregiver_attested
  readonly actorKind: AdministrationActorKind;
  readonly witnessMembershipId: string | null;
  readonly status: AdministrationStatus;
  readonly lateEntryTier: AdministrationLateEntryTier;
  readonly requiresRnReview: boolean;
  readonly data: unknown; // per-mode payload (TypeBox-typed)
  readonly drugNameSnapshot: string;
  readonly rxnormRxcuiSnapshot: string | null;
  readonly routeSnapshot: string;
  readonly doseAmountSnapshot: number | null;
  readonly doseUnitSnapshot: string | null;
  readonly isControlledSubstance: boolean;
  readonly isSudTreatment: boolean;
  readonly isComfortKitDrawdown: boolean;
  readonly documentId: string | null;
}

/** §2.12 — one reconciliation worksheet's read projection. */
export interface ReconciliationWorksheetDto {
  readonly id: ReconciliationWorksheetId;
  readonly organizationId: string;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly triggerKind: ReconciliationTriggerKind;
  readonly triggeredAt: IsoInstant;
  readonly finalizedAt: IsoInstant | null;
  readonly finalizedByMembershipId: string | null;
  readonly status: ReconciliationWorksheetStatus;
  readonly lineCount: number;
  readonly decisionCounts: Record<ReconciliationDecisionKind, number>;
}

/** §2.12 — the M31 portal lay-language administration summary (one administered medication). */
export interface PortalAdministrationSummary {
  readonly administrationRecordId: AdministrationRecordId;
  readonly displayName: string; // lay-language drug name
  readonly administeredAt: IsoInstant;
  readonly mode: AdministrationMode;
  readonly isRedacted: boolean; // SUD-treatment redaction per §7.8 / D7
}

/** §2.12 — the M28 FHIR `MedicationAdministration` projection (opaque to M13; M28 maps to a FHIR resource;
 * the IV-continuous segment sequence composes into a single resource with an `effectivePeriod`). */
export interface FhirMedicationAdministrationPayload {
  readonly resourceType: "MedicationAdministration";
  readonly id: AdministrationRecordId;
  readonly status: "completed" | "entered-in-error" | "stopped" | "in-progress" | "unknown";
  readonly subjectPatientId: PatientId;
  readonly medicationDisplay: string;
  readonly rxnormRxcui: string | null;
  readonly effectiveDateTime: IsoInstant | null;
  readonly effectivePeriod: { readonly start: IsoInstant; readonly end: IsoInstant | null } | null;
}

// ── §2.12 D16 — the two M13-OWNED seams (impls + M1-registry wiring land M13-T07) ─────────────────────

/**
 * §2.12 D16 — the medication-administration read seam M14 (IDG "since last meeting"), M28 (FHIR
 * `MedicationAdministration`), M30 (PRN-effectiveness / missed-dose / reconciliation-timeliness measures),
 * M31 (portal summary), M33 (metrics), and M37 (IPU IV-pump overlay) consume. M13 OWNS the
 * `administration_record` table + the recording workflow; downstream modules import this typed interface and
 * resolve it through the M1 seam registry (no schema import; no `dependsOn` edge to M13 beyond the
 * registry). The impl (`apps/backend/src/modules/13-emar/services/administration-provider.ts`) registers
 * into the M1 seam registry at boot (M13-T07).
 */
export interface MedicationAdministrationProvider {
  // Read paths (the hot paths for downstream consumers)
  getAdministration(orgId: string, administrationId: string): Promise<AdministrationDto | null>;
  getAdministrationsForPatient(
    orgId: string,
    patientId: string,
    opts?: { sinceIso?: string; untilIso?: string },
  ): Promise<AdministrationDto[]>;
  getAdministrationsForOrder(
    orgId: string,
    medicationOrderId: string,
  ): Promise<AdministrationDto[]>;
  // M14 IDG "since last meeting" view
  getAdministrationsSince(
    orgId: string,
    patientId: string,
    sinceIso: string,
  ): Promise<AdministrationDto[]>;
  // M30 measure inputs
  getPrnEffectivenessSummary(
    orgId: string,
    patientId: string,
    windowIso: { from: string; to: string },
  ): Promise<{
    prnCount: number;
    prnWithReassessmentCount: number;
    reassessmentRate: number;
  }>;
  getComfortKitDeploymentTimeline(
    orgId: string,
    admissionId: string,
  ): Promise<{
    deployedAt: string | null;
    firstAdministrationAt: string | null;
    intervalMinutes: number | null;
  } | null>;
  getMissedDoseSummary(
    orgId: string,
    patientId: string,
    windowIso: { from: string; to: string },
  ): Promise<{
    scheduledCount: number;
    administeredCount: number;
    missedCount: number;
    missedRate: number;
  }>;
  // M31 portal projection (lay-language; SUD-redacted unless consent allows)
  getPortalAdministrationSummary(
    orgId: string,
    patientId: string,
    asOfIso: string,
  ): Promise<{ summary: PortalAdministrationSummary[] }>;
  // M37 IPU IV-pump overlay
  getIvContinuousSession(
    orgId: string,
    ivSessionId: string,
  ): Promise<{
    sessionId: string;
    medicationOrderId: string;
    startedAt: string;
    endedAt: string | null;
    segments: { kind: AdministrationMode; recordedAt: string; rate?: number; rateUnit?: string }[];
    pumpVerifiedByMembershipId: string | null;
  } | null>;
  // M28 FHIR projection
  asFhirMedicationAdministration(
    orgId: string,
    administrationId: string,
  ): Promise<FhirMedicationAdministrationPayload | null>;
}

/**
 * §2.12 D16 — the reconciliation read seam. M13 owns `medication_reconciliation_worksheet`; M14 (IDG packet)
 * and M30 (reconciliation-timeliness measure) read through it. Impl registers into the M1 registry at boot
 * (M13-T07).
 */
export interface ReconciliationProvider {
  getWorksheet(
    orgId: string,
    worksheetId: string,
  ): Promise<ReconciliationWorksheetDto | null>;
  getWorksheetsForAdmission(
    orgId: string,
    admissionId: string,
  ): Promise<ReconciliationWorksheetDto[]>;
  // M30 timeliness measure
  getReconciliationTimelinessByAdmission(
    orgId: string,
    admissionId: string,
  ): Promise<{
    admissionAt: string;
    reconciliationFinalizedAt: string | null;
    intervalHours: number | null;
    metFiveDayDeadline: boolean | null;
  }>;
}

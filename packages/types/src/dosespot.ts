// @wardenx/types — Module 12 (DoseSpot Integration) leaf contracts (M12-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package: the M12 spec's references to
// `packages/dosespot/src/seams.ts` (the §2.10 D17 `MedicationOrderProvider` / `RefillInboxProvider`),
// `packages/dosespot/src/alerts.ts` (the §4.9 typed M36 payloads), and `packages/dosespot/src/outbox.ts`
// (the §4.4 `m12.*` event names) resolve their TYPE surface HERE so downstream consumers (M13 eMAR, M14
// IDG, M28 FHIR, M31 portal, M33 metrics) import them with no `dependsOn` edge. The runtime impls + the
// M1-seam-registry wiring land later (the providers in M12-T07, the alert/outbox assemblers in M12-T08).
//
// M12-T01 ships the type-level surface every later M12 task builds on: the §3.2 pgEnum value mirrors, the
// §4.4 `m12.*` outbox event names, the §7.6 audit denylists (the M4 trigger arguments for M12-T02), the
// §4.9 typed alert payloads, the §2.10 owned-seam interfaces + read DTOs, and the §3.4 structured-sig
// projection. The per-class TypeBox `data` schemas + the `MED_CLASS_CATALOG` metadata live in the
// `@wardenx/dosespot` FEATURE package; the pure lifecycle machines + eligibility matrices land in
// `@wardenx/dosespot` in later tasks. This file is type-only and importable by everyone with no edge.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { PatientId, AdmissionId } from "./admission";
import type { IsoInstant } from "./care-plan";

// ── M12-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ──────────
export type MedicationOrderId = string;
export type MedicationOrderTransmissionId = string;
export type MedicationOrderDiscontinuationId = string;
export type RefillRequestId = string;
export type MedicationHistoryRecordId = string;
export type EpcsSigningAttemptId = string;
export type DoseSpotPrescriberId = string;
export type DoseSpotWebhookEventId = string;
/** A DoseSpot-side prescription identifier (returned by the NewRx API; not a WardenX uuid). */
export type DoseSpotPrescriptionId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ─────────────────────

/** The §2.2 D2 medication-order lifecycle status (mirrors `medication_order_status`). */
export type MedicationOrderStatus =
  | "draft"
  | "pending_signature"
  | "verbal_pending"
  | "epcs_identity_pending"
  | "signed"
  | "queued_for_transmission"
  | "transmitted"
  | "ack_received"
  | "nack_received"
  | "active"
  | "completed"
  | "discontinued"
  | "transmission_failed"
  | "expired_unsigned";

/** The §2.1 medication taxonomy (mirrors `med_class`). */
export type MedClass = "standard" | "controlled_substance" | "compounded";

/** The §2.4 DEA controlled-substance schedules (mirrors `dea_schedule`). */
export type DeaSchedule = "II" | "III" | "IV" | "V";

/** The §2.2 / §4.10 orthogonal NewRx-transmission observed state (mirrors `dosespot_send_state`). */
export type DoseSpotSendState =
  | "not_required"
  | "queued"
  | "in_flight"
  | "transmitted"
  | "acked"
  | "nacked"
  | "failed";

/** The §2.7 D9 refill-inbox lifecycle (mirrors `refill_request_status`). */
export type RefillRequestStatus = "pending" | "approved" | "denied" | "expired";

/** The §2.7 refill-decision channel (mirrors `refill_response_channel`). */
export type RefillResponseChannel =
  | "electronic_via_dosespot"
  | "phone"
  | "fax"
  | "in_person";

/** The §2.8 medication-history provenance (mirrors `medication_history_source`). */
export type MedicationHistorySource =
  | "dosespot_medhx"
  | "manual_entry"
  | "reconciliation_carryforward";

/** The §2.5 / §7.4 D7 typed inbound webhook taxonomy (mirrors `dosespot_webhook_event_type`). */
export type DoseSpotWebhookEventType =
  | "script_status_update"
  | "refill_request"
  | "medication_history_result"
  | "patient_mismatch"
  | "prescriber_status_changed";

/** The §2.4 §1311.115 IAL2 identity-proofing status (mirrors `ial2_status`). */
export type Ial2Status =
  | "not_started"
  | "in_progress"
  | "verified"
  | "expired"
  | "revoked";

/** The §2.4 D18 per-tenant EPCS certification gate (mirrors `epcs_certification_status`). */
export type EpcsCertificationStatus =
  | "not_certified"
  | "audit_in_progress"
  | "certified"
  | "revoked";

/** The §2.4 §1311.205 record-of-application outcome (mirrors `epcs_signing_attempt_outcome`). */
export type EpcsSigningAttemptOutcome =
  | "pending"
  | "succeeded"
  | "failed_2fa"
  | "failed_timeout"
  | "failed_validation";

/** The §2.4 §1311.116 second-factor type (mirrors `epcs_second_factor_type`). */
export type EpcsSecondFactorType = "totp" | "passkey" | "push_confirm";

/** The §2.2 / §2.12 discontinuation reasons (mirrors `medication_order_discontinuation_reason`). */
export type MedicationOrderDiscontinuationReason =
  | "clinical_judgement"
  | "patient_request"
  | "adverse_event"
  | "replaced_by_corrected_order"
  | "admission_discharged"
  | "pharmacy_nack"
  | "corrected_replacement"
  | "expired_verbal"
  | "transmission_failed"
  | "no_refills_no_renewal";

// ── §7.6 per-entity audit denylists (the free-text/PHI columns the M4 trigger must NOT mirror, D14) ────
// Captured here as data so M12-T02's `generateAuditTrigger(...)` denylist arguments derive from a single
// source. The trigger scrubs top-level columns only (M11-T02 precedent) — the per-kind free text
// (`sig_free_text` / `indication` / `clinical_justification` / `notes`) lives inside `medication_order.data`,
// so the whole `data` jsonb is denylisted; the webhook body columns are already DEK-encrypted at rest and
// further denylisted from the audit row (§7.6: the trigger records that a write happened, never the value).

/** The M12-owned table names that carry an M4 write-audit trigger (one per manifest `ownedTables`). */
export type M12TableName =
  | "medication_order"
  | "medication_order_transmission"
  | "refill_request"
  | "epcs_signing_attempt"
  | "dosespot_prescriber"
  | "dosespot_webhook_event";

/** Per-table audit denylist (§7.6). Empty array = no free-text/PHI column on that table. */
export const M12_AUDIT_DENYLIST: { readonly [K in M12TableName]: readonly string[] } = {
  medication_order: ["data"],
  medication_order_transmission: ["last_error_detail"],
  refill_request: ["pharmacy_notes", "denial_reason"],
  epcs_signing_attempt: [],
  dosespot_prescriber: [],
  dosespot_webhook_event: ["raw_body_cipher", "raw_body_dek"],
} as const;

// ── §4.4 outbox event names (the canonical `m12.*` wire identifiers the dispatcher + arch:gaps validate) ─

/** The full §4.4 M12 outbox taxonomy, in canonical `m12.<entity>.<verb>` / `m12.<entity>_<verb>` form (the
 * wire identifier the M1 dispatcher publishes). M13 consumes the lifecycle events (active/discontinued/
 * cascade); M14 the IDG-relevant events; M22 the form-render handshake events; M28 the FHIR-projection
 * events; M21 the pharmacy-dispense signal; M30 the survey-evidence stream; M33 the metrics stream; M36 the
 * typed alerts. The full publication + subscription wiring lands in M12-T08. */
export const M12_EVENT_NAMES = [
  "m12.medication_order.draft_created",
  "m12.medication_order.draft_created_from_extraction",
  "m12.medication_order.signature_requested",
  "m12.medication_order.signed",
  "m12.medication_order.epcs_2fa_failed",
  "m12.medication_order.verbal_received",
  "m12.medication_order.queued_for_transmission",
  "m12.medication_order.transmitted",
  "m12.medication_order.dispensed_at_pharmacy",
  "m12.medication_order.ack_received",
  "m12.medication_order.active",
  "m12.medication_order.nack_received",
  "m12.medication_order.transmission_failed",
  "m12.medication_order.discontinued",
  "m12.medication_order.completed",
  "m12.medication_order.list_changed",
  "m12.medication_order.document_requested",
  "m12.refill_request_received",
  "m12.refill_request_approved",
  "m12.refill_request_denied",
  "m12.refill_request_sla_warn",
  "m12.refill_request_sla_critical",
  "m12.medication_history_pulled",
  "m12.medication_history_reconciled",
  "m12.dosespot_patient_synced",
  "m12.dosespot_patient_sync_failed",
  "m12.prescriber_enrolled",
  "m12.prescriber_revoked",
  "m12.ial2_expiring_warn",
  "m12.dosespot_degraded",
  "m12.dosespot_recovered",
  "m12.controlled_substance_policy_changed",
  "m12.medication.error_reported",
] as const;

/** An M12 outbox event name (§4.4). */
export type M12EventName = (typeof M12_EVENT_NAMES)[number];

// ── §4.9 M36 typed alert payloads (the deterministic messages M12 emits; M36 doesn't re-template) ─────
// M12 emits typed alerts through M36's dispatch seam. The builders land in `@wardenx/dosespot` (M12-T08);
// this discriminated union is the shape M36 type-checks against. No PHI in the payloads — only IDs; M36
// resolves PHI per recipient permission scope (§4.9).

/** The §4.9 discriminated union of every typed alert M12 emits to M36. */
export type M12AlertPayload =
  | {
      readonly eventType: "medication_order.verbal_expiring_soon";
      readonly orderId: MedicationOrderId;
      readonly hoursUntilDeadline: number;
      readonly severity: "medium" | "high";
    }
  | {
      readonly eventType: "medication_order.verbal_expired_unsigned";
      readonly orderId: MedicationOrderId;
      readonly deadlineAt: string;
      readonly severity: "high";
    }
  | {
      readonly eventType: "medication_order.transmission_failed";
      readonly orderId: MedicationOrderId;
      readonly retryCount: number;
      readonly lastErrorClass: string;
      readonly severity: "high";
    }
  | {
      readonly eventType: "medication_order.nack_received";
      readonly orderId: MedicationOrderId;
      readonly rejectionReason: string;
      readonly pharmacyMdmId: string;
      readonly severity: "high";
    }
  | {
      readonly eventType: "medication_order.epcs_2fa_pattern";
      readonly prescriberMembershipId: string;
      readonly failureCount: number;
      readonly windowMinutes: number;
      readonly severity: "critical";
    }
  | {
      readonly eventType: "refill_request.received";
      readonly refillRequestId: RefillRequestId;
      readonly patientId: PatientId;
      readonly severity: "info";
    }
  | {
      readonly eventType: "refill_request.sla_warn";
      readonly refillRequestId: RefillRequestId;
      readonly hoursPending: number;
      readonly severity: "warn";
    }
  | {
      readonly eventType: "refill_request.sla_critical";
      readonly refillRequestId: RefillRequestId;
      readonly hoursPending: number;
      readonly severity: "critical";
    }
  | {
      readonly eventType: "medication_order.discharge_cascade";
      readonly admissionId: AdmissionId;
      readonly discontinuedCount: number;
      readonly severity: "info";
    }
  | {
      readonly eventType: "ial2.expiring_warn";
      readonly membershipId: string;
      readonly daysRemaining: number;
      readonly severity: "warn";
    }
  | {
      readonly eventType: "ial2.expiring_critical";
      readonly membershipId: string;
      readonly daysRemaining: number;
      readonly severity: "critical";
    }
  | {
      readonly eventType: "dosespot.degraded";
      readonly openedAt: string;
      readonly lastErrorClass: string;
      readonly severity: "high";
    }
  | {
      readonly eventType: "dosespot.recovered";
      readonly closedAt: string;
      readonly severity: "info";
    }
  | {
      readonly eventType: "patient_sync.failed";
      readonly patientId: PatientId;
      readonly retryCount: number;
      readonly severity: "warn";
    }
  | {
      readonly eventType: "pharmacy.mismatch";
      readonly medicationOrderId: MedicationOrderId;
      readonly severity: "warn";
    };

// ── §3.4 / §2.10 structured-sig projection (server-canonicalized; never the raw free-text) ────────────

/** §3.4 — the structured sig the seam DTO carries (canonicalized server-side; the free-text `sigFreeText`
 * is denylisted in audit and never crosses a seam). */
export interface SigStructuredDto {
  readonly doseQuantity: number;
  readonly doseUnit: string;
  readonly route: string;
  readonly frequencyCode: string;
  readonly duration?: {
    readonly durationValue: number;
    readonly durationUnit: "days" | "weeks" | "months";
  };
  readonly asNeeded: boolean;
  readonly asNeededReasonCode?: string;
}

// ── §2.10 D17 owned-seam read DTOs (read-only projections; never Drizzle rows) ────────────────────────

/** §2.10 — one medication order's read projection. The hot path every downstream consumer reads. */
export interface MedicationOrderDto {
  readonly id: MedicationOrderId;
  readonly organizationId: string;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly medClass: MedClass;
  readonly status: MedicationOrderStatus;
  readonly rxnormRxcui: string | null;
  readonly ndc: string | null;
  readonly drugName: string;
  readonly strength: string;
  readonly doseForm: string;
  readonly route: string;
  readonly sigStructured: SigStructuredDto;
  readonly prescriberMembershipId: string;
  readonly prescribingPhysicianMdmId: string;
  readonly dispensingPharmacyMdmId: string | null;
  readonly refillsRemaining: number;
  readonly signedAt: IsoInstant | null;
  readonly transmittedAt: IsoInstant | null;
  readonly activatedAt: IsoInstant | null;
  readonly discontinuedAt: IsoInstant | null;
  readonly isControlledSubstance: boolean;
  readonly deaSchedule: DeaSchedule | null;
  readonly isSudTreatment: boolean; // derived from M38 sud_treatment_medication value-set membership
  readonly derivedFromRefillId: RefillRequestId | null;
  readonly derivedFromHistoryId: MedicationHistoryRecordId | null;
  readonly replacesMedicationOrderId: MedicationOrderId | null;
  readonly documentId: string | null;
}

/** §2.7 — one refill request's read projection (the `RefillInboxProvider` surface). */
export interface RefillRequestDto {
  readonly id: RefillRequestId;
  readonly organizationId: string;
  readonly patientId: PatientId;
  readonly sourceMedicationOrderId: MedicationOrderId;
  readonly status: RefillRequestStatus;
  readonly requestedAt: IsoInstant;
  readonly requestedQuantity: number | null;
  readonly prescriberMembershipId: string | null;
  readonly resultingMedicationOrderId: MedicationOrderId | null;
}

/** §2.10 — the M31 portal lay-language medication summary (one active medication). */
export interface PortalMedicationSummary {
  readonly medicationOrderId: MedicationOrderId;
  readonly displayName: string;
  readonly instructions: string; // lay-language sig
  readonly status: MedicationOrderStatus;
  readonly isRedacted: boolean; // SUD-treatment redaction per §7.8 / D7
}

/** §2.10 — the M28 FHIR `MedicationRequest` projection (opaque to M12; M28 maps to a FHIR resource). */
export interface FhirMedicationRequestPayload {
  readonly resourceType: "MedicationRequest";
  readonly id: MedicationOrderId;
  readonly status: "active" | "stopped" | "completed" | "draft" | "unknown";
  readonly intent: "order";
  readonly subjectPatientId: PatientId;
  readonly medicationDisplay: string;
  readonly rxnormRxcui: string | null;
  readonly authoredOn: IsoInstant | null;
}

// ── §2.10 D17 — the two M12-OWNED seams (impls + M1-registry wiring land M12-T07) ─────────────────────

/**
 * §2.10 D17 — the medication-order read seam M13 (eMAR administration context), M14 (IDG packet), M19/M30/
 * M33 (derived signals + cost basis + quality), M28 (FHIR), and M31 (portal) consume. M12 OWNS the
 * `medication_order` table + the prescribing workflow; downstream modules import this typed interface and
 * resolve it through the M1 seam registry (no schema import; no `dependsOn` edge to M12 beyond the
 * registry). The impl (`apps/backend/src/modules/12-dosespot/services/medication-order-provider.ts`)
 * registers into the M1 seam registry at boot (M12-T07).
 */
export interface MedicationOrderProvider {
  // Read paths (the hot paths)
  getActiveMedications(orgId: string, patientId: string): Promise<MedicationOrderDto[]>;
  getMedicationsSince(
    orgId: string,
    patientId: string,
    sinceIso: string,
  ): Promise<MedicationOrderDto[]>;
  getMedicationOrder(
    orgId: string,
    medicationOrderId: string,
  ): Promise<MedicationOrderDto | null>;
  listForAdmission(
    orgId: string,
    admissionId: string,
    statuses?: MedicationOrderStatus[],
  ): Promise<MedicationOrderDto[]>;
  // M13 administration-context surface
  getAdministrationContext(
    orgId: string,
    medicationOrderId: string,
  ): Promise<{
    order: MedicationOrderDto;
    allowAdministration: boolean;
    blockedReasons: (
      | "not_active"
      | "discontinued"
      | "replaced"
      | "expired_unsigned"
      | "transmission_failed"
    )[];
  } | null>;
  // M19 / M30 / M33 derived signals
  getControlledSubstanceFlag(
    orgId: string,
    medicationOrderId: string,
  ): Promise<{ isControlled: boolean; schedule: string | null }>;
  getComfortKitDeploymentTimeline(
    orgId: string,
    admissionId: string,
  ): Promise<{ deployedAt: string | null; firstAdministrationAt: string | null } | null>;
  // M27 cost-basis rollup
  getCostBasisSummary(
    orgId: string,
    admissionId: string,
    monthIso: string,
  ): Promise<{ totalCostCents: number; lineCount: number }>;
  // M31 portal projection (lay-language)
  getPortalMedicationSummary(
    orgId: string,
    patientId: string,
  ): Promise<{ summary: PortalMedicationSummary[] }>;
  // M28 FHIR projection
  asFhirMedicationRequest(
    orgId: string,
    medicationOrderId: string,
  ): Promise<FhirMedicationRequestPayload | null>;
}

/**
 * §2.10 D17 — the refill-inbox read seam. M12 owns `refill_request`; the prescriber-inbox UI + M33 read
 * through this seam. Impl registers into the M1 registry at boot (M12-T07).
 */
export interface RefillInboxProvider {
  getPendingRefillsForPrescriber(
    orgId: string,
    prescriberMembershipId: string,
  ): Promise<RefillRequestDto[]>;
  getPendingRefillsForPatient(orgId: string, patientId: string): Promise<RefillRequestDto[]>;
  getRefillRequestById(
    orgId: string,
    refillRequestId: string,
  ): Promise<RefillRequestDto | null>;
}

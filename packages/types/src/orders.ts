// @wardenx/types — Module 11 (Orders) leaf contracts (M11-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package: the M11 spec's references to
// `packages/foundation/...` (the §4.4 HL7-ORM payload, the §4.9 lab alert types) resolve HERE — the
// `packages/foundation` package is BANNED (CLAUDE.md / architecture wins); the leaf `@wardenx/types`
// is the no-edge home for every cross-module type. M11-T01 ships the type-level surface every later M11
// task + every cross-module consumer builds on: the §3.2 pgEnum value mirrors, the §4.4 `m11.*` outbox
// event names, the §7.6 audit denylists (the M4 trigger arguments for M11-T02), the §4.9 typed alert
// payloads (the builders land M11-T07), and the two §2.8/§4.3 OWNED seams (`OrderSignatureProvider`,
// `OrderProvider`) M12/M13/M14/M30 consume (impls + M1-registry wiring land in M11-T05).
//
// The per-kind TypeBox `data` schemas + the `KIND_CATALOG` metadata + the pure lifecycle machines live in
// the `@wardenx/orders` FEATURE package and the `@wardenx/domain` leaf (land in M11-T03+); this file is
// type-only and importable by everyone with no dependsOn edge.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so
// the package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ─
import type { AdmissionId, PatientId, ProviderEntityId } from "./admission";
import type { IsoInstant, LocationId } from "./care-plan";

// ── M11-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ─────────
export type OrderRecordId = string;
export type OrderSignatureId = string;
export type VerbalOrderId = string;
export type StandingOrderId = string;
export type StandingOrderInstanceId = string;
export type OrderDiscontinuationId = string;
export type OrderVerbalPolicyId = string;

// ── §3.2 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ────────────────────

/** The eight §2.1 non-medication order kinds (mirrors `order_kind`). */
export type OrderKind =
  | "lab"
  | "dme"
  | "level_of_care_change"
  | "recertification"
  | "comfort_kit"
  | "supply"
  | "ancillary_service"
  | "idg_requested";

/** The full ordered §2.1 kind list (one entry per {@link OrderKind}). */
export const ORDER_KINDS = [
  "lab",
  "dme",
  "level_of_care_change",
  "recertification",
  "comfort_kit",
  "supply",
  "ancillary_service",
  "idg_requested",
] as const satisfies readonly OrderKind[];

/** The §2.2 D2 order lifecycle status (mirrors `order_status`). */
export type OrderStatus =
  | "draft"
  | "pending_signature"
  | "verbal_pending"
  | "active"
  | "completed"
  | "discontinued"
  | "expired_unsigned";

/** The §2.1 lab/dispatch priority (mirrors `order_priority`). */
export type OrderPriority = "routine" | "stat" | "asap";

/** The §2.8 D14 polymorphic-signature target discriminator (mirrors `order_signature_target_kind`). */
export type OrderSignatureTargetKind = "order" | "medication_order";

/** The §2.5 polymorphic signature class (mirrors `order_signature_kind`). */
export type OrderSignatureKind = "signature" | "cosignature" | "verbal_attestation";

/** The §2.3 D3 verbal-order timer lifecycle (mirrors `verbal_order_status`). */
export type VerbalOrderStatus = "pending" | "signed_in_time" | "expired_unsigned";

/** The §2.4 D5 standing-order spawn cadence (mirrors `standing_order_cadence`). */
export type StandingOrderCadence = "daily" | "weekly" | "biweekly" | "monthly" | "prn";

/** The §2.4 D5 standing-order template lifecycle (mirrors `standing_order_status`). */
export type StandingOrderStatus = "active" | "paused" | "expired" | "discontinued";

/** Provenance of a §2.4 standing-order spawn (mirrors `standing_order_spawned_by`). */
export type StandingOrderSpawnedBy = "system" | "clinician_request";

/** The §2.6 D13 discontinuation reasons (mirrors `order_discontinuation_reason`). */
export type OrderDiscontinuationReason =
  | "clinical_judgement"
  | "patient_request"
  | "adverse_event"
  | "replaced_by_corrected_order"
  | "admission_discharged"
  | "level_of_care_change"
  | "standing_order_discontinued"
  | "corrected_replacement"
  | "expired_verbal"
  // F-166 (#248) — a staff-initiated `m21.supply_request.cancelled` (never M11's own discharge cascade).
  | "supply_request_cancelled";

/** The §2.2 / §4.10 orthogonal lab-wire dispatch state (mirrors `order_transmission_status`). */
export type OrderTransmissionStatus =
  | "not_required"
  | "pending"
  | "pending_retry"
  | "transmitted"
  | "failed";

/** The §2.2 / §4.10 orthogonal lab-results-received state (mirrors `order_results_status`). */
export type OrderResultsStatus =
  | "not_expected"
  | "awaiting_results"
  | "partial_results_received"
  | "results_received"
  | "results_overdue";

// ── §7.6 per-entity audit denylists (the free-text/PHI columns the M4 trigger must NOT mirror, D11) ──
// Captured here as data so M11-T02's `generateAuditTrigger(...)` denylist arguments derive from a single
// source rather than being re-typed per table. The `order_record.data` jsonb carries each kind's free
// text (notes / collection_instructions / clinical_justification) plus `indication_text`; signatures
// carry the attestation + on-behalf reason; the verbal attestation, standing-order template free text,
// the PRN spawn note, and the discontinuation note are denylisted (§8.1: the trigger records that a
// write happened, never the value — `<scrubbed:N chars>`).

/** The M11 table names that own a write-audit trigger (one per §3.3 PHI table). */
export type M11TableName =
  | "order_record"
  | "order_signature"
  | "verbal_order"
  | "standing_order"
  | "standing_order_instance"
  | "order_discontinuation"
  | "order_verbal_policy"
  | "order_idg_decision_application";

/** Per-table audit denylist (§7.6 / §8.1). Empty array = no free-text PHI on that table. */
export const M11_AUDIT_DENYLIST: { readonly [K in M11TableName]: readonly string[] } = {
  order_record: ["data", "indication_text"],
  order_signature: ["attestation_text", "on_behalf_reason"],
  verbal_order: ["verbal_attestation"],
  standing_order: ["template_data", "indication_text"],
  standing_order_instance: ["spawn_context_note"],
  order_discontinuation: ["notes"],
  order_verbal_policy: [],
  order_idg_decision_application: [],
} as const;

// ── §4.4 outbox event names (the canonical `m11.*` wire identifiers the dispatcher + arch:gaps validate) ─

/** The full §4.4 M11 outbox taxonomy, in canonical `m11.order.<entity>_<verb>` form (the wire identifier
 * the M1 dispatcher publishes). M6 consumes the LCP / recertification signed events; M21 consumes the
 * supply-fulfillment / cancellation events; M29 consumes `hl7_orm_requested`; M22 renders form/result PDFs;
 * M30/M33 read the compliance + dashboard stream; M36 receives the typed alerts. The full publication
 * lands in M11-T07. */
export const M11_EVENT_NAMES = [
  "m11.order.draft_created",
  "m11.order.signature_requested",
  "m11.order.verbal_received",
  "m11.order.cosign_requested",
  "m11.order.cosigned",
  "m11.order.signed",
  "m11.order.signed_on_behalf",
  "m11.order.verbal_signed_in_time",
  "m11.order.verbal_expired_unsigned",
  "m11.order.discontinued",
  "m11.order.completed",
  "m11.order.corrected",
  "m11.order.level_of_care_change_signed",
  "m11.order.recertification_signed",
  "m11.order.supply_fulfillment_requested",
  "m11.order.supply_cancellation_requested",
  "m11.order.hl7_orm_requested",
  "m11.order.transmission_status_changed",
  "m11.order.transmission_terminal_failed",
  "m11.order.results_received",
  "m11.order.results_received_critical",
  "m11.order.results_overdue",
  "m11.order.idg_drafted",
  "m11.order.standing_created",
  "m11.order.standing_spawned",
  "m11.order.standing_discontinued",
  "m11.order.document_requested",
  "m11.order.verbal_expiring_soon",
  "m11.order.suggestion_state_changed",
] as const;

/** An M11 outbox event name (§4.4). */
export type M11EventName = (typeof M11_EVENT_NAMES)[number];

// ── §4.9 M36 typed alert payloads (the deterministic messages M11 emits; M36 doesn't re-template) ─────
// M11 emits typed alerts through M36's dispatch seam. The builders land in `@wardenx/orders` (M11-T07);
// these contracts are the shapes M36 type-checks against.

/** §4.9 — verbal order approaching its signature deadline (12h / 2h cadence). */
export interface OrderVerbalExpiringAlert {
  readonly kind: "order.verbal_expiring_soon";
  readonly organizationId: string;
  readonly patientId: PatientId;
  readonly orderId: OrderRecordId;
  readonly verbalOrderId: VerbalOrderId;
  readonly orderKind: OrderKind;
  readonly hoursUntilDeadline: number; // 12 or 2 per the cadence
  readonly severity: "medium" | "high";
  readonly recipients: {
    readonly orderingPhysicianMdmId: string;
    readonly recordingMembershipId: string;
    readonly careTeamChannel: true;
    readonly clinicalSupervisorInbox: "when_severity_high";
  };
  readonly bodyTemplate: string; // deterministic; M36 does not re-template
}

/** §4.9 — verbal order expired without signature (42 CFR 418.104(b) violation). */
export interface OrderVerbalExpiredAlert {
  readonly kind: "order.verbal_expired_unsigned";
  readonly organizationId: string;
  readonly patientId: PatientId;
  readonly orderId: OrderRecordId;
  readonly verbalOrderId: VerbalOrderId;
  readonly orderKind: OrderKind;
  readonly hoursOverdue: number;
  readonly severity: "high";
  readonly recipients: {
    readonly medicalDirectorInbox: true;
    readonly clinicalSupervisorInbox: true;
    readonly complianceOfficerInbox: true;
    readonly careTeamChannel: true;
    readonly orderingPhysicianMdmId: string;
  };
  readonly bodyTemplate: string;
  readonly complianceFlag: {
    readonly cfr: "42 CFR 418.104(b)";
    readonly violationKind: "verbal_order_not_signed_in_time";
  };
}

/** §4.9 — an LPN-drafted order awaiting RN/MD cosignature. */
export interface OrderCosignPendingAlert {
  readonly kind: "order.cosign_pending";
  readonly organizationId: string;
  readonly patientId: PatientId;
  readonly orderId: OrderRecordId;
  readonly orderKind: OrderKind;
  readonly cosignerRoleNeeded: "rn_case_manager" | "clinical_supervisor" | "medical_director";
  readonly drafterMembershipId: string;
  readonly severity: "medium";
  readonly recipients: {
    readonly caseManagerInbox: true;
    readonly clinicalSupervisorInbox: "when_role_eligible";
  };
  readonly bodyTemplate: string;
}

/** §4.9 — an IDG-decision-derived `idg_requested` draft awaiting clinician resolution. */
export interface OrderIdgDraftedAlert {
  readonly kind: "order.idg_drafted";
  readonly organizationId: string;
  readonly patientId: PatientId;
  readonly orderId: OrderRecordId;
  readonly triggeringIdgDecisionId: string;
  readonly severity: "medium";
  readonly recipients: {
    readonly caseManagerInbox: true;
    readonly idgCoordinatorInbox: true;
  };
  readonly bodyTemplate: string;
}

/** §4.9 — lab ORM transmission terminally failed (D16; no further M29 retries). */
export interface OrderLabTransmissionTerminalFailedAlert {
  readonly kind: "m11.lab_transmission.terminal_failed";
  readonly severity: "HIGH";
  readonly orderId: OrderRecordId;
  readonly orderingPhysicianMdmId: string | null;
  readonly failureReason: string;
  readonly transmittedAttempts: number;
  readonly callToAction: "manual_reorder" | "contact_partner";
}

/** §4.9 — lab results not received by the expected-by time. */
export interface OrderLabResultsOverdueAlert {
  readonly kind: "m11.lab_results.overdue";
  readonly severity: "MEDIUM";
  readonly orderId: OrderRecordId;
  readonly orderingPhysicianMdmId: string | null;
  readonly hoursOverdue: number;
  readonly priority: "S" | "A" | "R" | "T";
}

/** §4.9 — critical lab observation values received (M29 abnormal-flag dispatch; M11 surfaces the banner). */
export interface OrderLabResultsCriticalAlert {
  readonly kind: "m11.lab_results.critical";
  readonly severity: "CRITICAL";
  readonly orderId: OrderRecordId;
  readonly orderingPhysicianMdmId: string | null;
  readonly criticalFlags: readonly string[]; // 'HH', 'LL', 'AA'
}

/** The discriminated union of every typed alert M11 emits to M36 (§4.9). */
export type OrderAlertPayload =
  | OrderVerbalExpiringAlert
  | OrderVerbalExpiredAlert
  | OrderCosignPendingAlert
  | OrderIdgDraftedAlert
  | OrderLabTransmissionTerminalFailedAlert
  | OrderLabResultsOverdueAlert
  | OrderLabResultsCriticalAlert;

// ── §4.4 `m11.order.hl7_orm_requested` pinned typed contract (shared with M29; §4.4) ──────────────────
// The exact ORM payload the T-29.08 builder consumes. The spec sites this in `packages/foundation`;
// foundation is BANNED, so the producer/consumer-shared contract lives in this leaf.

/** §4.4 — the minimal PHI projection an outbound HL7 ORM carries (intentionally omits SSN/NK1/IN1/GT1). */
export interface OrderHl7PatientDemographics {
  readonly mrn: string;
  readonly internalMrnAuthority: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly dateOfBirth: string; // ISO yyyy-mm-dd
  readonly administrativeSex: "M" | "F" | "U" | "O" | string;
  readonly addressLine1?: string;
  readonly addressCity?: string;
  readonly addressState?: string;
  readonly addressPostal?: string;
}

/** §4.4 — the lab-order body the M29 ORM builder maps to PID/ORC/OBR/NTE segments. */
export interface OrderHl7LabOrderPayload {
  readonly orderId: OrderRecordId;
  readonly patientId: PatientId;
  readonly placerOrderNumber: string; // OBR-2 = WardenX order id without dashes; deterministic
  readonly observationIdentifier: {
    readonly code: string; // LOINC code
    readonly text: string;
    readonly codingSystem: string; // 'LN' for LOINC
  };
  readonly orderingProviderNpi: string; // ORC-12 / OBR-16
  readonly orderingProviderName: { readonly family: string; readonly given: string };
  readonly priority: "R" | "S" | "A" | "T";
  readonly clinicalNotes?: readonly string[]; // NTE segments
  readonly patientDemographics: OrderHl7PatientDemographics;
}

/** §4.4 — the pinned `m11.order.hl7_orm_requested` payload (M11 produces, M29 consumes). */
export interface OrmRequestedPayload {
  readonly orderId: OrderRecordId;
  readonly organizationId: string;
  readonly labDestinationFacilityId: string;
  readonly priority: "R" | "S" | "A" | "T"; // ORC-7 / OBR-5
  readonly requestedAt: string; // signed_at as ISO
  readonly labOrderPayload: OrderHl7LabOrderPayload;
}

// ── §2.8 / §4.3 owned-seam read DTOs (read-only projections; never Drizzle rows) ──────────────────────

/** The minimal who/where an order row denormalizes from the admission at draft-time (three-column
 * tenancy M11-F04). Carried on seam projections for PE/Location-scoped reporting. */
export interface OrderCaptureContext {
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
}

/** §4.3 — one order's read projection, the read M12/M13 (signature linkage) + M14 (IDG "since last IDG")
 * + M30 (quality measures) consume. Resolved within the caller's tenant context (RLS-scoped). */
export interface OrderRecordDto {
  readonly orderId: OrderRecordId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly kind: OrderKind;
  readonly status: OrderStatus;
  readonly priority: OrderPriority | null;
  readonly orderingPhysicianMdmId: string | null;
  readonly transmissionStatus: OrderTransmissionStatus;
  readonly resultsStatus: OrderResultsStatus;
  readonly triggeringAssessmentId: string | null;
  readonly triggeringHopeAssessmentId: string | null;
  readonly replacesOrderId: OrderRecordId | null;
  readonly version: number;
  readonly signedAt: IsoInstant | null;
  readonly createdAt: IsoInstant;
}

/** §4.3 — a discontinuation's read projection (`getDiscontinuationReason`). */
export interface OrderDiscontinuationDto {
  readonly discontinuationId: OrderDiscontinuationId;
  readonly orderId: OrderRecordId;
  readonly reason: OrderDiscontinuationReason;
  readonly actorMembershipId: string | null;
  readonly effectiveAt: IsoInstant;
}

// ── §2.8 D14 — the OrderSignatureProvider seam M12 consumes for medication-order signatures ───────────

/** §2.8 — the sign-target input the polymorphic signature path accepts (order OR medication_order). */
export interface SignOrderTargetInput {
  readonly organizationId: string;
  readonly targetKind: OrderSignatureTargetKind;
  readonly targetId: string;
  readonly signerMembershipId: string;
  /**
   * The signer's clinical discipline — the same §2.1 signer-matrix vocabulary M11's own route path
   * records (`OrderSignerDiscipline` in `@wardenx/orders`; this leaf cannot import the feature catalog,
   * so the wire representation is the same non-empty string every route body carries and
   * `order_signature.signer_discipline` persists). REQUIRED: the ledger column is NOT NULL and every
   * caller has the discipline in scope (M12's sign routes thread their `signerDiscipline` body field),
   * so a seam signature records the real value — the former `unattested_via_seam` sentinel is gone.
   */
  readonly signerDiscipline: string;
  readonly signedAtClient: string; // ISO; server records the authoritative timestamp
  readonly signatureKind: "signature" | "cosignature";
  readonly signatureContext?: { readonly onBehalfOf?: string; readonly reason?: string };
}

/** §2.8 — the verbal-order recording input (the recording RN attests; M40 physician id is the signer). */
export interface RecordVerbalOrderInput {
  readonly organizationId: string;
  readonly targetKind: OrderSignatureTargetKind;
  readonly targetId: string;
  readonly recordingMembershipId: string;
  readonly orderingPhysicianMdmId: string; // M40 ExternalPhysician id
  readonly verbalAttestation: string; // 100-2000 chars; denylisted in audit
  readonly receivedAt: string; // ISO
}

/** §2.8 — the cosignature input (RN/MD cosign over an LPN-drafted or escalation-jump order). */
export interface CosignOrderInput {
  readonly organizationId: string;
  readonly targetKind: OrderSignatureTargetKind;
  readonly targetId: string;
  readonly cosignerMembershipId: string;
  readonly cosignerRole: "rn_case_manager" | "clinical_supervisor" | "medical_director";
  readonly attestationText: string; // 50-1000 chars; denylisted in audit
}

/** §2.8 — the discontinuation input (operator command; the reason + effective timestamp drive the cascade). */
export interface DiscontinueOrderInput {
  readonly organizationId: string;
  readonly targetKind: OrderSignatureTargetKind;
  readonly targetId: string;
  readonly actorMembershipId: string;
  readonly reason: OrderDiscontinuationReason;
  readonly effectiveAt: string; // ISO
  readonly notes?: string; // denylisted in audit
}

/**
 * §2.8 D14 — the signature contract M12 imports for medication-order signatures. M11 OWNS the
 * `order_signature` table + the signature workflow; M12 imports this typed interface (M12.dependsOn
 * includes 11) and routes med-order signatures through it. No SQL FK from `order_signature.target_id`
 * to `medication_order.id` — the discriminator + application-layer integrity is the model. The impl
 * (`apps/backend/src/modules/11-orders/services/order-signature-provider.ts`) registers into the M1
 * seam registry at boot (M11-T05).
 */
export interface OrderSignatureProvider {
  signOrderTarget(
    input: SignOrderTargetInput,
  ): Promise<{ signatureId: OrderSignatureId; orderStatusAfter: string }>;
  recordVerbalOrder(
    input: RecordVerbalOrderInput,
  ): Promise<{ verbalOrderId: VerbalOrderId; deadlineAt: string }>;
  cosignOrder(input: CosignOrderInput): Promise<{ cosignatureId: OrderSignatureId }>;
  discontinueOrder(
    input: DiscontinueOrderInput,
  ): Promise<{ discontinuationId: OrderDiscontinuationId }>;
}

// ── §4.3 — the OrderProvider read seam (the read-side counterpart M14/M30/M7 consume) ─────────────────

/**
 * §4.3 — the order read seam M14 (IDG "since last IDG" tracked elements) + M30 (quality measures) +
 * M7 (care-plan intervention → order back-ref) + M21 (the §2.8 logical-FK check behind
 * `supply_request.source_order_id`) consume. Resolved within the caller's tenant context.
 * The impl + M1-registry wiring land in M11-T05.
 */
export interface OrderProvider {
  /**
   * M21-T04 — resolve ONE order by id. Added for the M21 supply cascade: `m11.order.supply_fulfillment_
   * requested` carries `orderId` but no patient or admission, and every M21 PHI row needs both, so the
   * consumer has to read the order back. M21's spec §2.8 words this as
   * `OrderProvider.assertOrderExistsAndActive(orderId)`; the seam returns the row (or null) instead of
   * asserting, because "does it still exist" and "is it still active" are two different decisions and the
   * §7.1 cascade branches on the second one (a discharged/cancelled order does NOT dead-letter — it opens
   * the request and immediately cancels it). The store read this projects has existed since M11-T05.
   */
  getOrder(input: { orderId: OrderRecordId }): Promise<OrderRecordDto | null>;
  findActiveOrder(input: {
    patientId: PatientId;
    kind: OrderKind;
    spans?: [string, string];
  }): Promise<OrderRecordDto | null>;
  listByPatient(input: {
    patientId: PatientId;
    status?: OrderStatus[];
    kinds?: OrderKind[];
    limit?: number;
  }): Promise<OrderRecordDto[]>;
  listByAdmission(input: {
    admissionId: AdmissionId;
    status?: OrderStatus[];
    kinds?: OrderKind[];
  }): Promise<OrderRecordDto[]>;
  getOrdersSince(input: { patientId: PatientId; since: string }): Promise<OrderRecordDto[]>;
  getDiscontinuationReason(input: {
    orderId: OrderRecordId;
  }): Promise<OrderDiscontinuationDto | null>;
  getVerbalOrderTimeliness(input: {
    orderId: OrderRecordId;
  }): Promise<{
    deadlineAt: string;
    signedAt: string | null;
    status: VerbalOrderStatus;
    onTime: boolean;
  } | null>;
  /**
   * ORG-LEVEL verbal-order timeliness population over a RECEIPT window — M30's
   * `verbal_order_signature_on_time` input. Returns the numerator/denominator PAIR, not a rate: M30's
   * kernel suppresses a measure whose denominator is under the CMS reportable floor. Aggregate only.
   */
  getVerbalTimelinessCountsForOrg(
    organizationId: string,
    window: { from: string; to: string },
  ): Promise<{ readonly numerator: number; readonly denominator: number }>;
  findByTriggeringAssessment(assessmentId: string): Promise<OrderRecordDto[]>;
  findByCarePlanIntervention(interventionId: string): Promise<OrderRecordDto | null>;
}

/**
 * §4.4 — internal marker the M1 outbox dispatcher uses to type-check M11 subscribers. M11 performs no
 * direct cross-module writes at the boundary; all downstream communication is the `m11.*` outbox.
 */
export type OrderEventPublisher = Record<string, never>;

// @chartwarden/types — Module 21 (Supplies, DME & Comfort Kits) leaf contracts (M21-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package: the M21 spec's §4.8 reference
// to `packages/seams/src/supplies.ts` resolves its TYPE surface HERE, so the downstream consumers (M11
// order auto-complete, M13 bedside kit inventory, M22 BOL / return-receipt rendering, M27 invoice accrual,
// M30 the survey-investigable controlled-substance log, M33 dashboards, M36 alerts, M37 the IPU-room kit)
// import them with NO `dependsOn` edge. M21 never imports another module's feature package.
//
// M21-T01 ships the type-level surface every later M21 task builds on: the §3.1.1 pgEnum value mirrors,
// the §3.1 owned-table names + the D13 audit denylists and retention classes (the M4 trigger arguments
// M21-T02 passes), the §4.5 `m21.*` outbox event names + payload types, the §4.5.1 subscribed-event names,
// the §4.7 typed M36 alert payloads, and the §4.8 / D14 published-seam interfaces + their read DTOs. The
// pure-data policy — the D1 per-kind `data` TypeBox schemas, the D2 transition graph, the D3 platform-floor
// comfort kit + tighten-only validator, the D4 routing precedence ladder, the D8 reconciliation math —
// lives in the `@chartwarden/supplies` FEATURE package. This file is type-only, importable by everyone.
//
// NAMING: every exported symbol carries a `Supply` / `ComfortKit` / `VendorRouting` / `ParStock` / `M21`
// prefix. `@chartwarden/types` is re-exported wholesale from `./index.ts`, so a bare `DeliveryMethod` /
// `DispatchStatus` / `ReturnState` would be a TS2308 collision the day M18 / M24 / M37 wants the same word
// (the M14 `IdgDecisionPayload` precedent). `ComfortKitDeploymentId` and `ComfortKitDisposalStatus` are
// already M13's (`emar.ts`) — M21's dispatch-side ids are `ComfortKitDispatch*`.
//
// SPEC READ (§3.0 / ADR-0023): where §3.1's SQL and the prose diverge, §3.1 is normative. Two divergences
// are resolved that way here — D13 names a `reconciliation_notes` column that §3.1 does not create (the
// free-text field on `comfort_kit_return` is `discrepancy_notes`), and D8's prose formula references an
// `expected_consumed_if_known` term that §3.1's `m21_compute_return_discrepancy()` trigger does not use.
// The mirrors below follow §3.1 in both cases.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { AdmissionId, LocalDate, OrgId, PatientId, ProviderEntityId } from "./admission";
import type { IsoInstant, LocationId, MembershipId } from "./care-plan";
import type { DocumentId } from "./documents";
import type { MedicationOrderId } from "./dosespot";
import type { ComfortKitDeploymentId } from "./emar";
import type { HospiceCoverageDeterminationChangedPayload } from "./hospice-coverage";
import type { OrderRecordId } from "./orders";

// ── M21-owned id aliases (mirror the §3.1 uuid PKs; packages/types cannot import @chartwarden/db) ─────────
export type SupplyItemId = string;
export type TenantSupplyItemExtensionId = string;
export type ComfortKitTemplateId = string;
export type ComfortKitTemplateMedicationId = string;
export type VendorRoutingRuleId = string;
export type ParStockId = string;
export type SupplyRequestId = string;
export type ComfortKitDispatchId = string;
export type ComfortKitDispatchedContentId = string;
export type ComfortKitReturnId = string;
export type ComfortKitReturnedContentId = string;

/** Soft refs M21 stores but does not own: the M40 DME vendor / partner pharmacy a routing rule assigns, the
 *  M37 IPU room an `ipu_room` kit sits in, and the M1 outbox row a replenish request was born from. Each is
 *  a §2.8 LOGICAL FK — validated through the owning module's Provider seam at write time, never a SQL FK. */
export type DmeVendorId = string;
export type PharmacyPartnerId = string;
export type IpuRoomId = string;
export type OutboxEventId = string;

// ── §3.1.1 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts`) ───────────────────

/** The D1 shared-row discriminator (mirrors `m21_supply_request_kind`). M11 signs one order kind
 *  `comfort_kit`; M21 splits it — only `comfort_kit_replenish` has no M11 order behind it. */
export type SupplyRequestKind = "dme" | "supply" | "comfort_kit_deploy" | "comfort_kit_replenish";

/** The §2.2 / D2 fulfillment lifecycle (mirrors `m21_supply_request_status`). */
export type SupplyRequestStatus =
  | "requested"
  | "vendor_assigned"
  | "ordered"
  | "in_transit"
  | "delivered"
  | "received_confirmed"
  | "completed"
  | "cancelled"
  | "cancellation_pending"
  | "returned";

/** D17 — the site discriminator on a comfort-kit dispatch (mirrors `m21_deployment_site`). */
export type ComfortKitDeploymentSite = "home" | "alf" | "snf_residence" | "ipu_room";

/** D6 — who physically fills the kit (mirrors `m21_pharmacy_dispatch_mode`). */
export type PharmacyDispatchMode =
  | "supply_hub_dispatch"
  | "partner_pharmacy_dispatch"
  | "dosespot_to_partner_pharmacy";

/** D4 — what a resolved routing rule assigns (mirrors `m21_fulfillment_mode`). Only `vendor` requires a
 *  non-null vendor id; on the other three a null vendor is CORRECT, not an unresolved routing failure. */
export type SupplyFulfillmentMode =
  | "vendor"
  | "internal_supply_hub"
  | "partner_pharmacy"
  | "dosespot_to_partner_pharmacy";

/** DEA schedule of a kit medication, 21 CFR §1308 (mirrors `m21_controlled_substance_schedule`). */
export type ControlledSubstanceSchedule = "CII" | "CIII" | "CIV" | "CV";

/** D6 / CoP 418.106(f)(3) / DEA 21 CFR §1317 (mirrors `m21_disposal_method`). */
export type ComfortKitDisposalMethod =
  | "take_back_by_supply_team"
  | "dispose_at_home_by_witnessed_destruction"
  | "transferred_to_disposing_pharmacy";

/** The §2.6 / D8 chain-of-custody machine (mirrors `m21_return_state`). */
export type ComfortKitReturnState =
  | "requested"
  | "assigned"
  | "retrieving"
  | "retrieved"
  | "reconciled"
  | "overdue"
  | "unreturnable";

/** D4 — the precedence ladder a routing rule sits on (mirrors `m21_routing_scope_kind`). */
export type VendorRoutingScopeKind = "sku" | "location" | "tenant" | "platform";

/** D7 — how the item physically reached the patient (mirrors `m21_delivery_method`). */
export type SupplyDeliveryMethod =
  | "agency_courier"
  | "vendor_direct_ship"
  | "pharmacy_partner_courier"
  | "patient_pickup"
  | "in_facility_internal";

/** D6 — which DEA registration the kit left from (mirrors `m21_dispatch_source`). */
export type ComfortKitDispatchSource = "supply_hub" | "pharmacy_partner" | "dosespot_pharmacy";

/** M21-F04 — the dispatch row's own lifecycle (mirrors `m21_comfort_kit_dispatch_status`). It deliberately
 *  does NOT track the parent request status: the request goes terminal at deployment while the dispatch
 *  stays live through the whole return + reconciliation tail. */
export type ComfortKitDispatchStatus =
  | "dispatched"
  | "deployed_at_patient"
  | "partially_returned"
  | "fully_returned"
  | "reconciled"
  | "reconciled_with_discrepancy";

/** §2.2 — who confirmed receipt. `system_auto_confirm` is the 72-hour no-response fallback and is the one
 *  value that means "nobody actually said yes"; every read surface must render it distinctly. */
export type SupplyReceivedConfirmedActor =
  | "caregiver"
  | "patient"
  | "supply_team"
  | "system_auto_confirm";

/** §2.1 — the DME acquisition cadence. `monthly` is the recurring-rental HCPCS line that keeps a request
 *  in `received_confirmed` for the rental life; `one_time_purchase` auto-completes on receipt. */
export type DmeRentalCadence = "monthly" | "one_time_purchase";

/** §2.1 — the replenishment urgency M13's drawdown event carries into a replenish request. */
export type SupplyReplenishUrgencyKind = "routine" | "urgent";

/** D11 — the HCPCS-prefix class a SKU routes on. `internal` is the non-billable tenant-overlay class that
 *  has no HCPCS at all (§3.1's `supply_item` CHECK: billable ⇒ HCPCS present). */
export type SupplySkuClass = "E" | "A" | "B" | "K" | "L" | "Q" | "internal";

// ── §3.1 owned tables + the D13 audit denylist / retention class (M4 trigger arguments for M21-T02) ───

/** The twelve tables M21 owns per the manifest `ownedTables`. */
export type M21TableName =
  | "supply_item"
  | "tenant_supply_item_extension"
  | "comfort_kit_template"
  | "comfort_kit_template_medication"
  | "vendor_routing_rule"
  | "par_stock"
  | "supply_request"
  | "comfort_kit_dispatch"
  | "comfort_kit_dispatched_content"
  | "comfort_kit_return"
  | "comfort_kit_returned_content"
  | "supply_request_pharmacy_dispense";

export const M21_TABLE_NAMES = [
  "supply_item",
  "tenant_supply_item_extension",
  "comfort_kit_template",
  "comfort_kit_template_medication",
  "vendor_routing_rule",
  "par_stock",
  "supply_request",
  "comfort_kit_dispatch",
  "comfort_kit_dispatched_content",
  "comfort_kit_return",
  "comfort_kit_returned_content",
  "supply_request_pharmacy_dispense",
] as const satisfies readonly M21TableName[];

/**
 * §3.1.11 / D13 — the clinician-authored free-text columns the M4 PHI write-audit trigger scrubs out of the
 * before/after snapshot. These fields have a documented history of carrying names, dates of birth and full
 * addresses ("leave with the daughter Maria at the blue house, she gets home at 4").
 *
 * DENYLIST READ: the quantity columns are deliberately NOT denylisted anywhere. `dispatched_quantity`,
 * `quantity_returned`, `quantity_disposed_at_home` and `lot_number` ARE the DEA 21 CFR §1304 perpetual log
 * — scrubbing them from the audit snapshot would delete the only record of what changed in a controlled-
 * substance count, which is precisely the record a diversion investigation reads.
 */
export const M21_AUDIT_DENYLIST: { readonly [K in M21TableName]: readonly string[] } = {
  supply_item: [],
  tenant_supply_item_extension: [],
  comfort_kit_template: [],
  comfort_kit_template_medication: ["notes"],
  vendor_routing_rule: [],
  par_stock: ["reorder_notes"],
  supply_request: [
    "delivery_instructions",
    "cancellation_reason",
    // F-193 (#248) — the caregiver-signature evidence jsonb can carry a typed or witness NAME.
    "caregiver_signature_evidence_jsonb",
  ],
  comfort_kit_dispatch: ["special_handling_notes"],
  comfort_kit_dispatched_content: [],
  comfort_kit_return: ["disposal_notes", "discrepancy_notes", "unreturnable_reason"],
  comfort_kit_returned_content: [],
  supply_request_pharmacy_dispense: [],
} as const;

/** §3.1.11 — the ADR-0004 retention class each owned table's audit rows carry. The five kit / request
 *  tables are `compliance` (DEA 1304 records outlive the clinical record); `supply_request` is `clinical`
 *  because it is per-patient and follows the medical record; the catalog / config tables are operational. */
export const M21_AUDIT_RETENTION_CLASS: {
  readonly [K in M21TableName]: "clinical" | "compliance" | "operational";
} = {
  supply_item: "operational",
  tenant_supply_item_extension: "operational",
  comfort_kit_template: "operational",
  comfort_kit_template_medication: "operational",
  vendor_routing_rule: "operational",
  par_stock: "operational",
  supply_request: "clinical",
  comfort_kit_dispatch: "compliance",
  comfort_kit_dispatched_content: "compliance",
  comfort_kit_return: "compliance",
  comfort_kit_returned_content: "compliance",
  supply_request_pharmacy_dispense: "compliance",
} as const;

// ── §4.5.2 emitted outbox events ─────────────────────────────────────────────────────────────────────

/**
 * The `m21.*` events M21 publishes. Three names are normalized against the §4.5.2 table so every one
 * follows the M01 D8 / M03 D9 `mN.<resource>.<verb>` convention the `arch:gaps` event-catalog check
 * enforces (architecture wins over a spec table): the spec's two-segment `m21.controlled_substance_
 * discrepancy`, `m21.vendor_confirmation_overdue` and `m21.delivery_overdue` become
 * `m21.controlled_substance.discrepancy_detected`, `m21.supply_request.vendor_confirmation_overdue` and
 * `m21.supply_request.delivery_overdue`. No consumer is built yet, so the rename costs nothing.
 */
export const M21_EVENT_NAMES = [
  "m21.supply_request.status_changed",
  "m21.supply_request.created_from_external",
  "m21.supply_request.delivered",
  "m21.supply_request.cancelled",
  "m21.supply_request.cancel_no_op",
  "m21.supply_request.document_requested",
  "m21.supply_request.vendor_confirmation_overdue",
  "m21.supply_request.delivery_overdue",
  "m21.supply_request.invoice_accrued",
  "m21.supply_request.invoice_reconciled",
  // COP27 (42 CFR 418.24(c)) — a clinician set/changed a dme/supply request's hospice coverage determination.
  "m21.supply_request.coverage_determination_changed",
  "m21.comfort_kit.dispatched",
  "m21.comfort_kit.deployed_at_patient",
  "m21.comfort_kit.replenished",
  "m21.comfort_kit.returned",
  "m21.comfort_kit.return_reconciliation",
  "m21.comfort_kit.return_overdue",
  "m21.controlled_substance.discrepancy_detected",
  "m21.par.below_threshold",
  "m21.par.stockout_imminent",
] as const;

/** An M21 outbox event name (§4.5.2). */
export type M21EventName = (typeof M21_EVENT_NAMES)[number];

/** The §4.5 idempotency key each event's consumer de-duplicates on, beyond the M1 envelope's `event_id`
 *  every subscriber already keys on. */
export const M21_EVENT_IDEMPOTENCY_KEYS = {
  "m21.supply_request.status_changed": "supplyRequestId",
  "m21.comfort_kit.dispatched": "dispatchId",
  "m21.comfort_kit.deployed_at_patient": "dispatchId",
  "m21.comfort_kit.returned": "returnId",
  "m21.comfort_kit.return_reconciliation": "returnId",
  "m21.controlled_substance.discrepancy_detected": "returnId",
} as const satisfies Partial<Record<M21EventName, string>>;

/**
 * §4.5.1 — the events M21 SUBSCRIBES to. Listed here (not just in the worker files) so M21-T04's consumer
 * wiring and the §9 tests share one source of truth, and so a rename upstream breaks the build rather than
 * silently orphaning a handler. M21 owns none of these prefixes; consuming them needs no `dependsOn` edge.
 *
 * D18 READ: `m6.admission.discharged` is deliberately ABSENT. M11 and M13 are the canonical M6 cascade
 * recipients — each owns the per-domain reading of a discharge and emits its own cascade. Subscribing here
 * too would create the three-way race where M11, M13 and M21 disagree on the discharge-time kit posture.
 */
export const M21_SUBSCRIBED_EVENT_NAMES = [
  "m11.order.supply_fulfillment_requested",
  "m11.order.supply_cancellation_requested",
  "m11.order.discontinued",
  "m13.comfort_kit.replenishment_needed",
  "m13.comfort_kit.return_required",
  // F-094/#205 — M21 has DECIDERS for these two (`consumers/m13-comfort-kit.ts`) and the catalog named
  // m14 and m30 and not m21, so the relay routed them past the only module that acts on a kit deployment
  // or a CII discrepancy. Both events now declare `m21`.
  "m13.comfort_kit.deployed",
  "m13.comfort_kit.controlled_substance_discrepancy",
  // F-153 (#248) — `m11.order.signed` REMOVED: misdeclared, not unbound — redundant with the co-emitted,
  // more specific `m11.order.supply_fulfillment_requested` sibling (same transaction), dropped from the
  // catalog's own `declaredConsumers` at the source.
  "m12.medication_order.dispensed_at_pharmacy",
  "m22.document.rendered",
] as const;

/** One §4.5.1 subscribed event name. */
export type M21SubscribedEventName = (typeof M21_SUBSCRIBED_EVENT_NAMES)[number];

// ── §4.5.2 outbox payloads (the shape each subscriber type-checks against) ────────────────────────────

/** Fields every per-patient M21 event carries so a consumer can scope without a second read. */
export interface M21PatientScopedEventBase {
  readonly orgId: OrgId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
}

/** `m21.supply_request.status_changed` — every §2.2 transition. M11 auto-completes a one-shot order on
 *  `toStatus='completed'`; M33 counts the transition; M4 audits. `sourceOrderId` is null only for the
 *  replenish kind (there is no M11 order behind a drawdown-driven request). */
export interface M21SupplyRequestStatusChangedPayload extends M21PatientScopedEventBase {
  readonly supplyRequestId: SupplyRequestId;
  readonly kind: SupplyRequestKind;
  readonly sourceOrderId: OrderRecordId | null;
  readonly fromStatus: SupplyRequestStatus;
  readonly toStatus: SupplyRequestStatus;
  readonly occurredAt: IsoInstant;
}

/** `m21.supply_request.created_from_external` — a request created through the §4.8
 *  `SupplyFulfillmentProvider` rather than the M11 cascade (a coordinator's direct entry). */
export interface M21SupplyRequestCreatedFromExternalPayload extends M21PatientScopedEventBase {
  readonly supplyRequestId: SupplyRequestId;
  readonly kind: SupplyRequestKind;
  readonly createdByMembershipId: MembershipId;
  readonly occurredAt: IsoInstant;
}

/** §2.2 / D7 — the courier attestation captured at the `delivered` transition. Required on every kind:
 *  the "who put the hospital bed in the room?" question is asked long after the row goes terminal. */
export interface SupplyCourierAttestation {
  readonly deliveredByMembershipId: MembershipId;
  readonly deliveredAt: IsoInstant;
  readonly deliveryMethod: SupplyDeliveryMethod;
  /** M22 signature/photo artifact when tenant policy asked for one; null when policy did not. */
  readonly evidenceDocumentId: DocumentId | null;
}

/** `m21.supply_request.delivered` — the row reached `delivered` with its D7 courier attestation. The
 *  optional caregiver-signature capture is M21's own (F-193, #248) — synchronous, not an outbox
 *  consumer; see `SupplyCaregiverSignatureCaptureMethod` below. */
export interface M21SupplyRequestDeliveredPayload extends M21PatientScopedEventBase {
  readonly supplyRequestId: SupplyRequestId;
  readonly kind: SupplyRequestKind;
  readonly courierAttestation: SupplyCourierAttestation;
}

/** F-193 (#248) — M21's OWN caregiver-signature capture. D7's spec line ("caregiver signature is optional
 *  via M22's signature flow, triggered when policy or tenant config requires it") named a mechanism M22
 *  was never going to build (M22's own spec disclaims signature capture; see the `delivered` payload's
 *  F-191 history and `events-by-m21.ts`'s comment for the full citation trail). This mirrors the SHAPE
 *  (not the type — M21's manifest `dependsOn` has no edge to M39) of `@chartwarden/consent`'s proven
 *  `ConsentCaptureEvidence.captureMethod`, narrowed to what is plausible for a courier-delivery caregiver
 *  signature: no portal session, no uploaded PDF, no notary — just typed-in-app, a witnessed verbal
 *  account, or an explicit decline (still evidence worth recording). ALWAYS OPTIONAL: nothing reads this
 *  as a gate on delivery completion or any other transition. Mirrors `m21_caregiver_signature_capture_method`. */
export type SupplyCaregiverSignatureCaptureMethod =
  | "typed_signature_in_app"
  | "witnessed_verbal_documented"
  | "declined";

/** F-193 (#248) — the method-specific free-text evidence stored in
 *  `supply_request.caregiver_signature_evidence_jsonb`. Exactly one group is populated per method:
 *  `typedSignatureName` for `typed_signature_in_app`; `witnessName` + `witnessAttestationText` for
 *  `witnessed_verbal_documented` (the M22 document reference for that method is the discrete
 *  `caregiverSignatureEvidenceDocumentId` field, not part of this jsonb — the same split
 *  `deliveryEvidenceDocumentId` makes from the courier attestation); `declinedReason` (optional) for
 *  `declined`. Free text — on the M4 audit denylist (`M21_AUDIT_DENYLIST.supply_request`). */
export interface SupplyCaregiverSignatureEvidence {
  readonly typedSignatureName?: string;
  readonly witnessName?: string;
  readonly witnessAttestationText?: string;
  readonly declinedReason?: string;
}

/** `m21.supply_request.cancelled` — the row reached `cancelled`. M11 releases the order. */
export interface M21SupplyRequestCancelledPayload extends M21PatientScopedEventBase {
  readonly supplyRequestId: SupplyRequestId;
  readonly sourceOrderId: OrderRecordId | null;
  readonly reason: string;
  readonly cancelledAt: IsoInstant;
  /** True when the vendor had to confirm the cancellation first (the row sat in `cancellation_pending`). */
  readonly requiredVendorConfirmation: boolean;
}

/** `m21.supply_request.cancel_no_op` — an M11 cancellation cascade reached an already-terminal request.
 *  Emitted so M11 learns the cascade ARRIVED; silence would be indistinguishable from a lost event. */
export interface M21SupplyRequestCancelNoOpPayload {
  readonly orgId: OrgId;
  readonly supplyRequestId: SupplyRequestId;
  readonly sourceOrderId: OrderRecordId;
  readonly terminalStatus: SupplyRequestStatus;
  readonly occurredAt: IsoInstant;
}

/** `m21.supply_request.document_requested` — M22 renders the BOL / packing list for this request. */
export interface M21SupplyRequestDocumentRequestedPayload extends M21PatientScopedEventBase {
  readonly supplyRequestId: SupplyRequestId;
  readonly dispatchId: ComfortKitDispatchId | null;
  readonly documentKind: "bill_of_lading" | "packing_list" | "return_receipt";
  readonly requestedAt: IsoInstant;
}

/** `m21.supply_request.vendor_confirmation_overdue` — §2.10, a request sat in `ordered` past the tenant's
 *  vendor-confirmation window (default 24h). Advisory: nothing about the order is wrong yet. */
export interface M21SupplyRequestVendorConfirmationOverduePayload
  extends M21PatientScopedEventBase {
  readonly supplyRequestId: SupplyRequestId;
  readonly orderedAt: IsoInstant;
  readonly windowHours: number;
  readonly detectedAt: IsoInstant;
}

/** `m21.supply_request.delivery_overdue` — §2.10, an `in_transit` request passed its own
 *  `data.deliveryWindowLatest`. Only fires when the request declared a window. */
export interface M21SupplyRequestDeliveryOverduePayload extends M21PatientScopedEventBase {
  readonly supplyRequestId: SupplyRequestId;
  readonly deliveryWindowLatest: IsoInstant;
  readonly detectedAt: IsoInstant;
}

/** `m21.supply_request.invoice_accrued` — D16, the M27 forward seam. Amounts are integer CENTS, never a
 *  float: a rounding drift on a cap-relevant accrual is a reportable finding. */
export interface M21SupplyRequestInvoiceAccruedPayload extends M21PatientScopedEventBase {
  readonly supplyRequestId: SupplyRequestId;
  readonly vendorId: DmeVendorId | null;
  readonly invoiceTotalCents: number;
  readonly invoiceCurrency: "USD";
  readonly accruedAt: IsoInstant;
}

/** `m21.supply_request.invoice_reconciled` — D16. `varianceCents` is signed: positive means the vendor
 *  billed above the accrual. */
export interface M21SupplyRequestInvoiceReconciledPayload extends M21PatientScopedEventBase {
  readonly supplyRequestId: SupplyRequestId;
  readonly invoiceTotalCents: number;
  readonly varianceCents: number;
  readonly reconciledAt: IsoInstant;
}

/** One dispatched medication line as it travels on the wire (§2.5). Quantities are decimal STRINGS because
 *  the column is `numeric` — a 0.1 mL that round-trips through a JS float is not the number the DEA log
 *  recorded. Every consumer parses with the same decimal helper. */
export interface ComfortKitDispatchedContentPayload {
  readonly dispatchedContentId: ComfortKitDispatchedContentId;
  readonly comfortKitTemplateMedicationId: ComfortKitTemplateMedicationId;
  /** Logical FK to M12; null for the IPU-stock kit, which has no per-patient prescription behind it. */
  readonly medicationOrderId: MedicationOrderId | null;
  readonly rxnorm: string;
  readonly ndc: string | null;
  readonly drugName: string;
  readonly strength: string;
  readonly dosageForm: string;
  readonly routeOfAdministration: string;
  readonly isControlledSubstance: boolean;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule | null;
  readonly dispatchedQuantity: string;
  readonly dispatchedUnit: string;
  /** NOT NULL on every controlled line (§3.1 CHECK); optional-but-recommended otherwise. */
  readonly lotNumber: string | null;
  readonly expirationDate: LocalDate | null;
  readonly manufacturerNdc: string | null;
  readonly replenishmentThresholdPct: number;
}

/** `m21.comfort_kit.dispatched` — the dispatch row exists and the kit left the hub. Not yet at the patient. */
export interface M21ComfortKitDispatchedPayload extends M21PatientScopedEventBase {
  readonly dispatchId: ComfortKitDispatchId;
  readonly supplyRequestId: SupplyRequestId;
  readonly comfortKitTemplateId: ComfortKitTemplateId;
  readonly kitSerialNumber: string;
  readonly dispatchSource: ComfortKitDispatchSource;
  readonly pharmacyDispatchMode: PharmacyDispatchMode;
  readonly pharmacyPartnerId: PharmacyPartnerId | null;
  readonly dispatchedByMembershipId: MembershipId;
  readonly dispatchedAt: IsoInstant;
}

/** `m21.comfort_kit.deployed_at_patient` — §2.5. M13 creates the `comfort_kit_deployment` + per-medication
 *  drawdown rows from this payload, so it carries the FULL content list (M13 must not have to read back
 *  through a seam to learn what is in the kit it is about to track). */
export interface M21ComfortKitDeployedAtPatientPayload extends M21PatientScopedEventBase {
  readonly dispatchId: ComfortKitDispatchId;
  readonly supplyRequestId: SupplyRequestId;
  readonly deploymentSite: ComfortKitDeploymentSite;
  /** Non-null only when `deploymentSite === 'ipu_room'` (§3.1 CHECK). */
  readonly ipuRoomId: IpuRoomId | null;
  readonly deployedAt: IsoInstant;
  readonly deployedByMembershipId: MembershipId;
  readonly contents: readonly ComfortKitDispatchedContentPayload[];
  readonly bolDocumentId: DocumentId | null;
}

/** `m21.comfort_kit.replenished` — a `comfort_kit_replenish` request reached the patient. `contents` is a
 *  SUBSET of the original deployment (only the lines that crossed threshold), so M13 tops up rather than
 *  re-creating the deployment. */
export interface M21ComfortKitReplenishedPayload extends M21PatientScopedEventBase {
  readonly dispatchId: ComfortKitDispatchId;
  readonly supplyRequestId: SupplyRequestId;
  readonly sourceDeploymentId: ComfortKitDeploymentId;
  readonly replenishedAt: IsoInstant;
  readonly contents: readonly ComfortKitDispatchedContentPayload[];
}

/** `m21.comfort_kit.returned` — the return row reached `reconciled`. M13 flips its deployment's disposal
 *  status. The per-line accounting rides on the separate reconciliation event. */
export interface M21ComfortKitReturnedPayload extends M21PatientScopedEventBase {
  readonly returnId: ComfortKitReturnId;
  readonly dispatchId: ComfortKitDispatchId;
  readonly m13DeploymentId: ComfortKitDeploymentId;
  readonly disposalMethod: ComfortKitDisposalMethod;
  readonly reconciledByMembershipId: MembershipId;
  readonly disposalWitnessMembershipId: MembershipId | null;
  readonly reconciledAt: IsoInstant;
}

/** One reconciled line: what went out, what came back, and what cannot be accounted for (§2.6 / D8). */
export interface ComfortKitReturnedContentPayload {
  readonly returnedContentId: ComfortKitReturnedContentId;
  readonly dispatchedContentId: ComfortKitDispatchedContentId;
  readonly comfortKitTemplateMedicationId: ComfortKitTemplateMedicationId;
  readonly medicationOrderId: MedicationOrderId | null;
  readonly rxnorm: string;
  readonly drugName: string;
  readonly isControlledSubstance: boolean;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule | null;
  readonly lotNumber: string | null;
  readonly dispatchedQuantity: string;
  readonly quantityReturned: string;
  readonly quantityDisposedAtHome: string;
  readonly quantityUnaccounted: string;
  readonly discrepancyPct: number;
  readonly discrepancyFlagged: boolean;
}

/** `m21.comfort_kit.return_reconciliation` — the full per-line accounting. M13 closes its drawdowns; M30
 *  files the survey record when `discrepancyDetected`. */
export interface M21ComfortKitReturnReconciliationPayload extends M21PatientScopedEventBase {
  readonly returnId: ComfortKitReturnId;
  readonly dispatchId: ComfortKitDispatchId;
  readonly m13DeploymentId: ComfortKitDeploymentId;
  readonly discrepancyDetected: boolean;
  readonly perMedicationReconciliation: readonly ComfortKitReturnedContentPayload[];
  readonly reconciledAt: IsoInstant;
}

/** `m21.comfort_kit.return_overdue` — §2.6. `escalation` distinguishes the 30-day compliance surface from
 *  the 90-day assumption-of-loss, which also fires the discrepancy event for any controlled line. */
export interface M21ComfortKitReturnOverduePayload extends M21PatientScopedEventBase {
  readonly returnId: ComfortKitReturnId;
  readonly dispatchId: ComfortKitDispatchId;
  readonly returnRequiredAt: IsoInstant;
  readonly daysOverdue: number;
  readonly escalation: "overdue_30d" | "unreturnable_90d";
  readonly containsControlledSubstance: boolean;
  readonly detectedAt: IsoInstant;
}

/** `m21.controlled_substance.discrepancy_detected` — D8. High severity, survey-investigable. Carries the
 *  whole custody chain because the investigation question is "who touched it", not "how much is missing". */
export interface M21ControlledSubstanceDiscrepancyPayload extends M21PatientScopedEventBase {
  readonly returnId: ComfortKitReturnId;
  readonly dispatchId: ComfortKitDispatchId;
  readonly m13DeploymentId: ComfortKitDeploymentId | null;
  /** `m21_reconciliation` for M21's own 5% detection, `m13_reemit` when M13's bedside count found it. */
  readonly detectionSource:
    | "m21_reconciliation"
    | "m13_reemit"
    | "m21_unreturnable_assumption_of_loss";
  readonly discrepantMedications: readonly ComfortKitReturnedContentPayload[];
  readonly custodyChain: {
    readonly dispatchedByMembershipId: MembershipId;
    readonly retrievingMembershipId: MembershipId | null;
    readonly disposalWitnessMembershipId: MembershipId | null;
    readonly reconciledByMembershipId: MembershipId | null;
  };
  readonly detectedAt: IsoInstant;
}

/** `m21.par.below_threshold` / `m21.par.stockout_imminent` — §2.7 / D5. NOT patient-scoped: par stock is
 *  agency inventory at a Location, with no patient in it at all. */
export interface M21ParThresholdPayload {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
  readonly parStockId: ParStockId;
  readonly supplyItemId: SupplyItemId | null;
  readonly tenantSupplyItemExtensionId: TenantSupplyItemExtensionId | null;
  readonly supplyItemName: string;
  readonly currentQuantity: string;
  readonly reorderPoint: string;
  readonly minSafetyStock: string;
  readonly unit: string;
  readonly observedAt: IsoInstant;
}

/** The §4.5.2 name → payload map. A consumer that keys on the event name gets its payload type for free. */
export interface M21EventPayloadMap {
  "m21.supply_request.status_changed": M21SupplyRequestStatusChangedPayload;
  "m21.supply_request.created_from_external": M21SupplyRequestCreatedFromExternalPayload;
  "m21.supply_request.delivered": M21SupplyRequestDeliveredPayload;
  "m21.supply_request.cancelled": M21SupplyRequestCancelledPayload;
  "m21.supply_request.cancel_no_op": M21SupplyRequestCancelNoOpPayload;
  "m21.supply_request.document_requested": M21SupplyRequestDocumentRequestedPayload;
  "m21.supply_request.vendor_confirmation_overdue": M21SupplyRequestVendorConfirmationOverduePayload;
  "m21.supply_request.delivery_overdue": M21SupplyRequestDeliveryOverduePayload;
  "m21.supply_request.invoice_accrued": M21SupplyRequestInvoiceAccruedPayload;
  "m21.supply_request.invoice_reconciled": M21SupplyRequestInvoiceReconciledPayload;
  "m21.supply_request.coverage_determination_changed": HospiceCoverageDeterminationChangedPayload;
  "m21.comfort_kit.dispatched": M21ComfortKitDispatchedPayload;
  "m21.comfort_kit.deployed_at_patient": M21ComfortKitDeployedAtPatientPayload;
  "m21.comfort_kit.replenished": M21ComfortKitReplenishedPayload;
  "m21.comfort_kit.returned": M21ComfortKitReturnedPayload;
  "m21.comfort_kit.return_reconciliation": M21ComfortKitReturnReconciliationPayload;
  "m21.comfort_kit.return_overdue": M21ComfortKitReturnOverduePayload;
  "m21.controlled_substance.discrepancy_detected": M21ControlledSubstanceDiscrepancyPayload;
  "m21.par.below_threshold": M21ParThresholdPayload;
  "m21.par.stockout_imminent": M21ParThresholdPayload;
}

// ── §4.7 typed M36 alert payloads ────────────────────────────────────────────────────────────────────

/** A request stuck in a pre-delivery state past its SLO. Advisory — the supply team unsticks it. */
export interface SupplyRequestStalledAlert {
  readonly alertKind: "m21.supply_request.stalled";
  readonly supplyRequestId: SupplyRequestId;
  readonly orgId: OrgId;
  readonly patientId: PatientId;
  readonly stalledInStatus: Extract<
    SupplyRequestStatus,
    "requested" | "vendor_assigned" | "ordered" | "in_transit"
  >;
  readonly stalledDurationHours: number;
  readonly severity: "low" | "medium" | "high";
}

/** Par stock at or below reorder point. `depleted` is the zero case and is NOT the same as `critical_low`:
 *  a depleted hub cannot fill the next dispatch at all. */
export interface ParBelowThresholdAlert {
  readonly alertKind: "m21.par.below_threshold";
  readonly orgId: OrgId;
  readonly locationId: LocationId;
  readonly parStockId: ParStockId;
  readonly supplyItemName: string;
  readonly reorderPoint: string;
  readonly currentQuantity: string;
  readonly severity: "below_threshold" | "critical_low" | "depleted";
}

/** D8 — always high, always survey-escalated. There is no low-severity controlled-substance shortfall. */
export interface ControlledSubstanceDiscrepancyAlert {
  readonly alertKind: "m21.controlled_substance.discrepancy";
  readonly returnId: ComfortKitReturnId;
  readonly dispatchId: ComfortKitDispatchId;
  readonly orgId: OrgId;
  readonly patientId: PatientId;
  readonly discrepantMedications: readonly {
    readonly rxnorm: string;
    readonly drugName: string;
    readonly schedule: ControlledSubstanceSchedule;
    readonly lotNumber: string | null;
    readonly discrepancyPct: number;
  }[];
  readonly severity: "high";
  readonly surveyEscalationRecommended: true;
}

/** A kit that has not come back. `medium` at 30 days, `high` at 90 (the assumption-of-loss boundary). */
export interface UnreturnedKitAlert {
  readonly alertKind: "m21.comfort_kit.unreturned";
  readonly returnId: ComfortKitReturnId;
  readonly dispatchId: ComfortKitDispatchId;
  readonly orgId: OrgId;
  readonly patientId: PatientId;
  readonly daysSinceReturnRequired: number;
  readonly containsControlledSubstance: boolean;
  readonly severity: "medium" | "high";
}

/** §2.5 — the dispatch transaction rolled back. The request stayed in `vendor_assigned`; nothing shipped. */
export interface ComfortKitDispatchFailedValidationAlert {
  readonly alertKind: "m21.comfort_kit.dispatch_failed_validation";
  readonly supplyRequestId: SupplyRequestId;
  readonly orgId: OrgId;
  readonly patientId: PatientId;
  readonly reason:
    | "controlled_substance_dispatcher_denied"
    | "expiration_window_violation"
    | "missing_lot_number"
    | "par_stock_insufficient"
    | "template_floor_medication_missing";
  readonly severity: "high";
}

/** §2.2 — the vendor refused a post-`ordered` cancellation. The row stays where it was; compliance decides. */
export interface VendorCancellationRefusedAlert {
  readonly alertKind: "m21.supply_request.vendor_cancellation_refused";
  readonly supplyRequestId: SupplyRequestId;
  readonly orgId: OrgId;
  readonly patientId: PatientId;
  readonly currentStatus: SupplyRequestStatus;
  readonly vendorReason: string | null;
  readonly severity: "medium";
}

export type SuppliesAlertPayload =
  | SupplyRequestStalledAlert
  | ParBelowThresholdAlert
  | ControlledSubstanceDiscrepancyAlert
  | UnreturnedKitAlert
  | ComfortKitDispatchFailedValidationAlert
  | VendorCancellationRefusedAlert;

// ── §4.8 / D14 published-seam read DTOs ──────────────────────────────────────────────────────────────

/** D4 — the immutable precedence record written to `supply_request.routing_rule_resolved_jsonb` at the
 *  `vendor_assigned` transition. This is what a surveyor reads when asking "why did this hospital bed go
 *  to Apria rather than Lincare on 2026-06-09?" — the chain reconstructs even after the rules change. */
export interface RoutingRuleResolved {
  readonly resolverVersion: string;
  readonly resolvedAt: IsoInstant;
  readonly precedenceLevelUsed: VendorRoutingScopeKind;
  readonly matchedRuleId: VendorRoutingRuleId | null;
  readonly assignedVendorId: DmeVendorId | null;
  readonly assignedFulfillmentMode: SupplyFulfillmentMode;
  readonly defaultPharmacyDispatchMode: PharmacyDispatchMode | null;
  readonly candidatesEvaluated: readonly {
    readonly precedenceLevel: VendorRoutingScopeKind;
    readonly ruleId: VendorRoutingRuleId | null;
    readonly matched: boolean;
    readonly reason: string;
  }[];
  readonly routingPolicyDigest: string;
}

/** The `SupplyFulfillmentProvider.createDirectSupplyRequest` input (§4.8). `data` stays `unknown` on the
 *  seam: it is validated against the per-kind TypeBox in `@chartwarden/supplies` at the M21 boundary, and a
 *  structurally-typed union here would let a caller construct a `data` the validator then rejects. */
export interface CreateDirectSupplyRequestInput {
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly locationId: LocationId;
  readonly kind: SupplyRequestKind;
  readonly data: unknown;
  readonly sourceOrderId: OrderRecordId | null;
  readonly sourceReplenishmentEventId: OutboxEventId | null;
  readonly requestedByMembershipId: MembershipId;
}

export interface SupplyRequestStatusView {
  readonly supplyRequestId: SupplyRequestId;
  readonly orgId: OrgId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly kind: SupplyRequestKind;
  readonly status: SupplyRequestStatus;
  readonly sourceOrderId: OrderRecordId | null;
  readonly assignedVendorId: DmeVendorId | null;
  readonly routingRuleResolved: RoutingRuleResolved | null;
  readonly vendorOrderReference: string | null;
  readonly trackingNumber: string | null;
  readonly carrier: string | null;
  readonly orderedAt: IsoInstant | null;
  readonly deliveredAt: IsoInstant | null;
  readonly receivedConfirmedAt: IsoInstant | null;
  readonly receivedConfirmedActor: SupplyReceivedConfirmedActor | null;
  readonly completedAt: IsoInstant | null;
  readonly cancelledAt: IsoInstant | null;
  readonly createdAt: IsoInstant;
}

/** What M13 needs at the bedside: which kits are live for this patient right now. */
export interface ActiveDispatchView {
  readonly dispatchId: ComfortKitDispatchId;
  readonly supplyRequestId: SupplyRequestId;
  readonly orgId: OrgId;
  readonly patientId: PatientId;
  readonly comfortKitTemplateId: ComfortKitTemplateId;
  readonly kitSerialNumber: string;
  readonly deploymentSite: ComfortKitDeploymentSite;
  readonly ipuRoomId: IpuRoomId | null;
  readonly dispatchStatus: ComfortKitDispatchStatus;
  readonly dispatchedAt: IsoInstant;
  readonly m13DeploymentId: ComfortKitDeploymentId | null;
  readonly containsControlledSubstance: boolean;
}

export interface DispatchDetailView extends ActiveDispatchView {
  readonly dispatchSource: ComfortKitDispatchSource;
  readonly pharmacyDispatchMode: PharmacyDispatchMode;
  readonly pharmacyPartnerId: PharmacyPartnerId | null;
  readonly dispatchedByMembershipId: MembershipId;
  readonly bolDocumentId: DocumentId | null;
  readonly controlledSubstanceHandlingPolicyDigest: string;
  readonly contents: readonly ComfortKitDispatchedContentPayload[];
}

/**
 * D6 / DEA 21 CFR §1304 — ONE entry in the perpetual inventory log kept on
 * `comfort_kit_dispatched_content.dea_perpetual_log_jsonb` (M21-T05).
 *
 * §1304.04(f) requires a running record of every transaction touching a scheduled unit, and §1304.03 makes
 * that record APPEND-ONLY: an entry is never edited or removed, because "what did the log say before
 * someone changed it" is the first question a DEA inspection asks. The column is therefore an ARRAY of
 * these, and M21 only ever pushes onto it.
 *
 * `balanceAfterQuantity` is the running balance AS RECORDED, not a value derived at read time. That is the
 * whole point of a perpetual log — a balance recomputed from the current row set would silently absorb a
 * missing entry, which is exactly the discrepancy the log exists to expose.
 */
export interface DeaPerpetualLogEntry {
  /** What happened to the unit. `dispense` leaves the registrant's stock; `administer_drawdown` is M13's
   *  bedside count; `return` / `disposal` close it out; `adjustment` is a corrected count, which is added
   *  as a NEW entry rather than by editing the one it corrects. */
  readonly transactionKind:
    | "dispense"
    | "administer_drawdown"
    | "return"
    | "disposal"
    | "adjustment";
  /** Signed decimal string — negative removes from the unit's balance. Never a JS number (see the M21
   *  event-catalog header: a 0.1 mL that round-trips through a float is not the quantity recorded). */
  readonly quantityDelta: string;
  /** The running balance recorded WITH this entry (see above — recorded, never recomputed). */
  readonly balanceAfterQuantity: string;
  readonly unit: string;
  /** WHO — the §1304 "person making the entry". */
  readonly recordedByMembershipId: MembershipId;
  /** The second signature §1317 requires on a witnessed destruction; null on the other kinds. */
  readonly witnessMembershipId: MembershipId | null;
  readonly occurredAt: IsoInstant;
  /** The M21 row that caused the entry (a dispatch, a return, an M13 drawdown), for reconstruction. */
  readonly sourceReference: string | null;
}

/** M13 → M21 when a bedside count disagrees with the lot's expected remainder. Cascades into the §2.6
 *  reconciliation pipeline; it does NOT itself decide a discrepancy exists. */
export interface AdministrationDrawdownInput {
  readonly dispatchId: ComfortKitDispatchId;
  readonly dispatchedContentId: ComfortKitDispatchedContentId;
  readonly observedRemainingQuantity: string;
  readonly expectedRemainingQuantity: string;
  readonly observedByMembershipId: MembershipId;
  readonly observedAt: IsoInstant;
}

/** D17 / M37 forward seam — what is physically in an IPU room's stock kit. No patient scope: an IPU-room
 *  kit belongs to the room, and the patient in the bed changes under it. */
export interface IpuRoomKitInventoryView {
  readonly locationId: LocationId;
  readonly ipuRoomId: IpuRoomId;
  readonly dispatches: readonly DispatchDetailView[];
}

/** Cost aggregation for hospice-cap analysis (M27) and finance reporting. Amounts are integer CENTS.
 *
 *  SEAM READ: this returns COUNTS and TOTALS, never a per-day or per-patient RATE. The denominator (how
 *  many patient days, how many patients) is what drives CMS small-N suppression downstream, and a
 *  pre-divided number destroys it — the M15-T05 / M30 lesson. */
export interface PatientSupplyCostSummary {
  readonly patientId: PatientId;
  readonly orgId: OrgId;
  readonly fromDate: LocalDate;
  readonly toDate: LocalDate;
  readonly dmeTotalCents: number;
  readonly supplyTotalCents: number;
  readonly comfortKitTotalCents: number;
  readonly totalCents: number;
  readonly accruedRequestCount: number;
  readonly unreconciledRequestCount: number;
}

export interface OrgSupplySpendSummary {
  readonly orgId: OrgId;
  readonly fromDate: LocalDate;
  readonly toDate: LocalDate;
  readonly dmeTotalCents: number;
  readonly supplyTotalCents: number;
  readonly comfortKitTotalCents: number;
  readonly totalCents: number;
  readonly patientCount: number;
  readonly requestCount: number;
}

// ── §4.8 / D14 published seam interfaces ─────────────────────────────────────────────────────────────
//
// Registered with the M1 boot seam registry in M21-T05; `validateSeams()` refuses startup if a consumer
// resolves an unregistered name. Every read is RLS-scoped by the caller's `withOrgContext`.

/** Consumed by M11 (order cascade), M22, M23/M27, M28, M30, M33. */
export interface SupplyFulfillmentProvider {
  /** Create a request outside the M11 order flow (a coordinator's direct entry). `data` is validated
   *  against the per-kind TypeBox before the row is written; an invalid shape is a 422, not a bad row. */
  createDirectSupplyRequest(input: CreateDirectSupplyRequestInput): Promise<{
    readonly supplyRequestId: SupplyRequestId;
    readonly routingRuleResolved: RoutingRuleResolved;
  }>;

  /** Current status of one request. Returns null when the id does not resolve IN THE CALLER'S ORG —
   *  indistinguishable from "does not exist" on purpose (a cross-tenant probe learns nothing). */
  getSupplyRequestStatus(supplyRequestId: SupplyRequestId): Promise<SupplyRequestStatusView | null>;

  /** M11 asks this before issuing a cancellation. Terminal means `completed` or `cancelled`; a request in
   *  `cancellation_pending` is NOT terminal — the vendor has not answered yet. */
  isTerminal(supplyRequestId: SupplyRequestId): Promise<{
    readonly isTerminal: boolean;
    readonly currentStatus: SupplyRequestStatus;
  } | null>;
}

/** Consumed by M13 (bedside inventory), M27, M30, M33, M37. */
export interface ComfortKitDispatchProvider {
  /** Kits live for this patient: `deployed_at_patient` and not yet fully reconciled. */
  listActiveDispatchesForPatient(patientId: PatientId): Promise<readonly ActiveDispatchView[]>;

  /** Full dispatch detail including lots and expirations — what M13 draws down against. */
  getDispatchDetail(dispatchId: ComfortKitDispatchId): Promise<DispatchDetailView | null>;

  /** D17 / M37 — the room's stock kit rather than a patient's. */
  getIpuRoomKitInventory(
    locationId: LocationId,
    ipuRoomId: IpuRoomId,
  ): Promise<IpuRoomKitInventoryView>;

  /** M13 reports a bedside count mismatch; M21 decides whether it is a D8 discrepancy. */
  notifyAdministrationDrawdown(input: AdministrationDrawdownInput): Promise<void>;
}

/** Consumed by M23 (cap) and M27 (cost report). */
export interface SupplyCostProvider {
  getPatientSupplyCostSummary(input: {
    readonly patientId: PatientId;
    readonly fromDate: LocalDate;
    readonly toDate: LocalDate;
  }): Promise<PatientSupplyCostSummary>;

  getOrgSupplySpendSummary(input: {
    readonly orgId: OrgId;
    readonly fromDate: LocalDate;
    readonly toDate: LocalDate;
  }): Promise<OrgSupplySpendSummary>;
}

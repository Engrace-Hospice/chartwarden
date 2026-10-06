// apps/backend/src/modules/12-dosespot/events-by-m12.ts — Module 12's outbox-event contributions
// (M12-T08, spec §4.4). The full `m12.*` taxonomy keyed on M12's own tables, under the `m12.` namespace
// (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file for naming
// (`mN.<resource>.<verb>`), ownership (moduleOwner='m12'), and valid declared consumers (real module ids).
// The canonical wire `eventName` mirrors `M12_EVENT_NAMES` in @wardenx/types (the closed §4.4 set the
// lifecycle machine / refill machine / transmission worker / webhook handler / patient-sync worker / roster
// service / SLA + IAL2 crons may emit). Each entry adds the TypeBox `payloadSchema` + declared consumers the
// dispatcher validates each publish against, so "DB updated but the event never went out" is closed in the
// same transaction as the mutation (M1 §25.5/§25.6).
//
// Phase-1 boundary (§0): the events whose declared consumers are future-wave modules (M21 supplies — Wave F;
// M22 PDF render; M28 FHIR projection; M13/M14 eMAR/IDG — Wave E later) are PUBLISHED now by M12 — the
// producer side ships, the consumer attaches when that module lands. M12 never calls those modules' routes;
// it only emits the typed outbox event.
import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import type { ModuleEventContribution, ModuleToken } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const medClass = Type.Union([
  Type.Literal("standard"),
  Type.Literal("controlled_substance"),
  Type.Literal("compounded"),
]);

// The §4.4 wire names mirror `M12_EVENT_NAMES` (@wardenx/types) EXACTLY — several merge resource+verb into a
// single token (`m12.refill_request_received`, `m12.medication_history_pulled`, …) rather than the stricter
// two-dot `OutboxEventName` template. They satisfy check-fitness-gaps' `mN.<...>` scan; `eventName` is relaxed
// to `string` here (every other field stays fully type-checked) and cast once to `ModuleEventContribution`.
interface M12OutboxEntry {
  readonly eventName: string;
  readonly moduleOwner: ModuleToken;
  readonly description: string;
  readonly payloadSchema: TSchema;
  readonly declaredConsumers: readonly ModuleToken[];
  readonly seamConsumers?: readonly ModuleToken[];
  readonly isOutboxOnly: boolean;
}

const M12_OUTBOX_ENTRIES: readonly M12OutboxEntry[] = [
  // ── medication-order authoring + signature lifecycle (§2.2 / §4.4) ──────────────────────────────────────
  {
    eventName: "m12.medication_order.draft_created",
    moduleOwner: "m12",
    description: "`createDraft` inserted a `draft` medication_order.",
    payloadSchema: Type.Object({
      orderId: id,
      patientId: id,
      medClass,
      isControlledSubstance: Type.Boolean(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.draft_created_from_extraction",
    moduleOwner: "m12",
    // F-235 (#248) — decision A1 (F-231): medications are EXCLUDED from DocLens writeback. M12 D12 and AI
    // Governance §2.1.1 hard-block AI-introduced medication changes, so no M22 commit ever targets M12
    // (`DOCLENS_M5_WRITEBACK_FIELDS` in @wardenx/types is the only allowlist, M5-only) and nothing in
    // production emits this; `m22` is dropped at the source, not deferred. Only the in-memory reference
    // service's `fromExtraction` arm still names it.
    description:
      "Reserved: a draft medication order minted from a DocLens extraction. NOT PRODUCED — DocLens medication writeback is excluded by decision A1 (M12 D12 / AI Governance §2.1.1); extracted medications stay read-only review evidence.",
    payloadSchema: Type.Object({
      orderId: id,
      patientId: id,
      medClass,
      sourceExtractionJobId: id,
      targetAggregateId: id,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.signature_requested",
    moduleOwner: "m12",
    description:
      "`requestSignature` moved a draft to `pending_signature`; M36 notifies the prescriber, M22 preps the PDF.",
    payloadSchema: Type.Object({
      orderId: id,
      prescriberMembershipId: id,
      prescribingPhysicianMdmId: id,
      // GAP-036 — present only when the prescriber acknowledged an allergy conflict. Class wording and the
      // acknowledging membership only; the free-text reason is never put on the bus.
      allergyOverride: Type.Optional(
        Type.Object({
          acknowledgedByMembershipId: Type.String({ minLength: 1 }),
          matchedClasses: Type.Array(Type.String({ minLength: 1 })),
          reasonLength: Type.Integer({ minimum: 1 }),
        }),
      ),
    }),
    // F-176 (#248) — m22 REMOVED: same harm as `m11.order.draft_created`; the real signed render is `.document_requested`.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.signed",
    moduleOwner: "m12",
    description:
      "M11's seam callback finalized the medication-order signature (standard / verbal / EPCS); broad fan-out.",
    payloadSchema: Type.Object({
      orderId: id,
      signerMembershipId: id,
      signedAt: isoInstant,
      viaVerbal: Type.Optional(Type.Boolean()),
      viaEpcs: Type.Optional(Type.Boolean()),
      secondFactorType: Type.Optional(id),
    }),
    declaredConsumers: [
      // F-104 — M14's §4.5 D8 auto-close closes an `order`/`medication_order`-linked action item
      // on this event, and this list did not name m14, so `assertBindableAgainstCatalog` would
      // have refused the binding for three of the six D8 sources while accepting the other three.
      "m14",
      // F-117 (#248) — m22 removed: `emitDocumentRequest` fires
      // `m12.medication_order.document_requested` from the same activation/sign path
      // (dosespot-route-service-db.ts) — the actual live-bound M22 render request.
      // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    ],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.epcs_2fa_failed",
    moduleOwner: "m12",
    description:
      "`signControlledSubstanceComplete` failure path; M36 alerts if a pattern emerges; security monitoring.",
    payloadSchema: Type.Object({
      orderId: id,
      prescriberMembershipId: id,
      outcomeDetail: Type.String(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.verbal_received",
    moduleOwner: "m12",
    description:
      "A verbal medication order opened a `verbal_pending` row + the M11 48h deadline; M36 DMs the prescriber.",
    payloadSchema: Type.Object({
      orderId: id,
      recordingMembershipId: id,
      deadlineAt: Type.Optional(isoInstant),
      namedPrescriberMdmId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.queued_for_transmission",
    moduleOwner: "m12",
    description:
      "`enqueueTransmission` queued the signed order for the `dosespot.transmit_newrx` worker.",
    payloadSchema: Type.Object({ orderId: id, transmissionId: id, idempotencyKey: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.transmitted",
    moduleOwner: "m12",
    description: "The `transmit-newrx` worker succeeded; M22 renders the PDF, M33 reports.",
    payloadSchema: Type.Object({
      orderId: id,
      dosespotPrescriptionId: id,
      transmittedAt: isoInstant,
      dispensingPharmacyMdmId: Type.Optional(Type.Union([id, Type.Null()])),
    }),
    declaredConsumers: ["m22"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.dispensed_at_pharmacy",
    moduleOwner: "m12",
    description:
      "The webhook handler saw a Dispensed/PickedUp script status; M21 reads the pharmacy-dispense signal.",
    payloadSchema: Type.Object({
      orderId: id,
      dosespotPrescriptionId: id,
      dispensedAt: isoInstant,
      dispensingPharmacyMdmId: Type.Optional(Type.Union([id, Type.Null()])),
      fillNumber: Type.Optional(Type.Integer()),
    }),
    declaredConsumers: ["m21"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.ack_received",
    moduleOwner: "m12",
    description:
      "The webhook handler recorded a pharmacy ack; the post-ack hook transitions the order to active.",
    payloadSchema: Type.Object({
      orderId: id,
      ackedAt: isoInstant,
      scriptStatusFromDoseSpot: Type.String(),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.active",
    moduleOwner: "m12",
    description:
      "The post-ack transition activated the medication order; the broad eMAR/IDG/FHIR/portal fan-out.",
    payloadSchema: Type.Object({ orderId: id, fullDto: Type.Unknown() }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-139 (#248) — m31 removed: M31's own spec (§4.10 "M31 consumes") is silent on every M12 event —
    // the active-medication list is a seam PULL (`MedicationOrderProvider.getPortalMedicationSummary`,
    // §4.4 "Depends on" item 12), never a push subscription this "portal fan-out" phrasing implies.
    declaredConsumers: ["m13", "m14"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.nack_received",
    moduleOwner: "m12",
    description:
      "The webhook handler saw a pharmacy reject; M36 raises a high-severity alert to prescriber + supervisor.",
    payloadSchema: Type.Object({
      orderId: id,
      nackedAt: isoInstant,
      rejectionReason: Type.String(),
      dispensingPharmacyMdmId: Type.Optional(Type.Union([id, Type.Null()])),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.transmission_failed",
    moduleOwner: "m12",
    description:
      "The `transmit-newrx` worker exhausted its retry budget; M36 high-severity, M30 survey log.",
    payloadSchema: Type.Object({
      orderId: id,
      lastErrorClass: Type.String(),
      retryCount: Type.Integer({ minimum: 0 }),
    }),
    // F-184 (#248) — m30 DROPPED: this description's own "M30 survey log" is an unverified, undefined
    // concept — M30's own locked spec's ENTIRE M12 relationship paragraph names exactly two consumed
    // methods (`MedicationOrderProvider.getOpioidOnAdmissionStats`/`getComfortKitDeploymentTimeline`,
    // both confirmed as `QualityMedicationOrderConsumer`'s only two real methods), neither about
    // transmission failures. No incident kind, measure, or seam anywhere references DoseSpot
    // transmission failures. A pure producer-side guess, the F-180 shape.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.discontinued",
    moduleOwner: "m12",
    description:
      "`discontinueOrder` (or the discharge cascade) flipped the order to discontinued; eMAR/IDG/FHIR close-out.",
    payloadSchema: Type.Object({
      orderId: id,
      reason: id,
      actorMembershipId: Type.Union([id, Type.Null()]),
      effectiveAt: isoInstant,
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    declaredConsumers: ["m13", "m14"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.completed",
    moduleOwner: "m12",
    description: "`completeOrder` finished an active order (one-shot / no-refills-no-renewal).",
    payloadSchema: Type.Object({
      orderId: id,
      completedAt: isoInstant,
      reason: Type.Optional(Type.String()),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_order.list_changed",
    moduleOwner: "m12",
    description:
      "Any transition that changed the active-medication set; M22 re-renders the med-list PDF, M31 refreshes the portal.",
    payloadSchema: Type.Object({
      patientId: id,
      addedOrderIds: Type.Array(Type.String()),
      removedOrderIds: Type.Array(Type.String()),
    }),
    // F-139 (#248) — m31 removed: same seam-pull redundancy as `medication_order.active` above — M31's
    // own §4.10 "M31 consumes" table names no M12 event; the portal refresh is `getPortalMedicationSummary`
    // read fresh, not a push.
    declaredConsumers: ["m22"],
    // ALSO live: server → patient room med-list refresh (§4.4 chart-banner cache).
    isOutboxOnly: false,
  },
  {
    eventName: "m12.medication_order.document_requested",
    moduleOwner: "m12",
    description:
      "Mirror of `signed` for the M22 form/PDF render handshake (§4.4 form rendering handshake).",
    payloadSchema: Type.Object({ orderId: id, formTemplate: id, renderPayload: Type.Unknown() }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  // ── refill inbox (§2.7 / §4.4) ──────────────────────────────────────────────────────────────────────────
  {
    eventName: "m12.refill_request_received",
    moduleOwner: "m12",
    description:
      "`receiveRefillRequest` opened a pending refill; M36 routine alert to prescriber + care team.",
    payloadSchema: Type.Object({
      refillRequestId: id,
      sourceMedicationOrderId: id,
      patientId: id,
      receivedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.refill_request_approved",
    moduleOwner: "m12",
    description: "`approveRefill` minted a new medication_order; M33 reports.",
    payloadSchema: Type.Object({
      refillRequestId: id,
      resultingOrderId: id,
      approvedByMembershipId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.refill_request_denied",
    moduleOwner: "m12",
    description:
      "`denyRefill` recorded a denial reason; M36 notifies the care-team channel, M33 reports.",
    payloadSchema: Type.Object({
      refillRequestId: id,
      deniedByMembershipId: id,
      denialReason: Type.String(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.refill_request_sla_warn",
    moduleOwner: "m12",
    description: "The `refill-sla` cron crossed the 48h warn threshold.",
    payloadSchema: Type.Object({
      refillRequestId: id,
      hoursPending: Type.Number(),
      severity: Type.Literal("warn"),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.refill_request_sla_critical",
    moduleOwner: "m12",
    description: "The `refill-sla` cron crossed the 72h critical threshold.",
    payloadSchema: Type.Object({
      refillRequestId: id,
      hoursPending: Type.Number(),
      severity: Type.Literal("high"),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── medication history (§2.8 / §4.4) ───────────────────────────────────────────────────────────────────
  {
    eventName: "m12.medication_history_pulled",
    moduleOwner: "m12",
    description:
      "`ingestPullResult` persisted a DoseSpot MedHx pull; M14 refreshes the IDG packet, M31 the portal list.",
    payloadSchema: Type.Object({
      patientId: id,
      rowsCreated: Type.Integer({ minimum: 0 }),
      sourceJobId: id,
    }),
    // F-139 (#248) — m31 removed: same seam-pull redundancy — the portal medication list is read via
    // `getPortalMedicationSummary`, never invalidated by this event.
    // F-230 (#248) — m14 moved to `seamConsumers` (the F-218 / M19 precedent): the F-101 rule — M14's own spec
    // builds the packet by seam reads and never names this event — makes the binding a PULL
    // (`idgMedicationHistoryForOrg` -> `PacketSnapshot.medicationHistory`), not an outbox consumer.
    declaredConsumers: [],
    seamConsumers: ["m14"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication_history_reconciled",
    moduleOwner: "m12",
    description: "`reconcile` recorded a carry_forward / discontinue / document_only decision.",
    payloadSchema: Type.Object({
      historyRecordId: id,
      decision: id,
      resultingOrderId: Type.Optional(Type.Union([id, Type.Null()])),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── patient sync (§2.6 / §4.4) ─────────────────────────────────────────────────────────────────────────
  {
    eventName: "m12.dosespot_patient_synced",
    moduleOwner: "m12",
    description: "The `patient-sync` worker upserted the patient to DoseSpot.",
    payloadSchema: Type.Object({ patientId: id, dosespotPatientId: id, syncedAt: isoInstant }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.dosespot_patient_sync_failed",
    moduleOwner: "m12",
    description: "The `patient-sync` worker exhausted retries; M36 alerts the org_admin.",
    payloadSchema: Type.Object({
      patientId: id,
      retryCount: Type.Integer({ minimum: 0 }),
      lastErrorClass: Type.String(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── prescriber roster + IAL2 (§2.4 / §4.4) ─────────────────────────────────────────────────────────────
  {
    eventName: "m12.prescriber_enrolled",
    moduleOwner: "m12",
    description: "`enrollPrescriber` registered a DoseSpot prescriber for the tenant.",
    payloadSchema: Type.Object({ membershipId: id, dosespotPrescriberId: id }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.prescriber_revoked",
    moduleOwner: "m12",
    description: "`revokePrescriber` revoked a prescriber's DoseSpot enrollment.",
    payloadSchema: Type.Object({ membershipId: id, reason: Type.String() }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.ial2_expiring_warn",
    moduleOwner: "m12",
    description:
      "The `ial2-expiry-warn` cron found a prescriber whose IAL2 identity proofing is expiring.",
    payloadSchema: Type.Object({
      membershipId: id,
      expiresAt: isoInstant,
      daysRemaining: Type.Integer(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── adapter health + policy + safety (§2.5 / §2.7 / §4.4) ───────────────────────────────────────────────
  {
    eventName: "m12.dosespot_degraded",
    moduleOwner: "m12",
    description:
      "The DoseSpot circuit breaker opened; M36 system alert to org_admin + WardenX ops (DR_BCP §10.4.3).",
    payloadSchema: Type.Object({
      breakerName: id,
      openedAt: isoInstant,
      lastErrorClass: Type.String(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.dosespot_recovered",
    moduleOwner: "m12",
    description:
      "The DoseSpot circuit breaker closed; the queued-on-recovery worker drains the backlog.",
    payloadSchema: Type.Object({ breakerName: id, closedAt: isoInstant }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.controlled_substance_policy_changed",
    moduleOwner: "m12",
    description:
      "An admin route changed the tenant controlled-substance policy; M33 + compliance log.",
    payloadSchema: Type.Object({
      actorMembershipId: Type.Optional(id),
      before: Type.Unknown(),
      after: Type.Unknown(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m12.medication.error_reported",
    moduleOwner: "m12",
    description:
      "`reportMedicationError` logged a medication error; M30 reads the medication-error rate.",
    payloadSchema: Type.Object({
      medicationErrorId: id,
      orderId: id,
      patientId: id,
      errorCategory: Type.String(),
      reportedByMembershipId: id,
      reportedAt: isoInstant,
      // F-205 (#248) — widened at the source: the new clinician-facing `reportMedicationError` route lets
      // the filing clinician add a free-text one-line summary, which M30's auto-incident-draft consumer
      // carries straight through to `incident_report.kind_data.narrativeText` (the F-185/`restraintKind`
      // precedent — an additive, optional field, never denylisted since it was already clinician-authored
      // free text at the API boundary, the same posture `m14.minutes.amended`'s `summary` already has).
      summary: Type.Optional(Type.String({ maxLength: 2000 })),
    }),
    declaredConsumers: ["m30"],
    isOutboxOnly: true,
  },
  // F-238 — M12's reply to `m22.extraction.medication_history_requested`: the DocLens medication lines it
  // recorded as reconciliation-only `medication_history_record` rows (source `doclens_intake`). D10/D12: no
  // `medication_order` is created, drafted or touched on this path; a clinician reconciles each row and
  // any order goes through the normal human prescribe flow. M22's `m22.extraction-clinical-writeback-backref`
  // stamps `extraction_provenance` from it.
  {
    eventName: "m12.medication_history_record.draft_created_from_extraction",
    moduleOwner: "m12",
    description:
      "M12 recorded a DocLens review's attested medication lines as reconciliation-only medication-history rows (source `doclens_intake`; never a medication_order). Carries a per-line outcome (created | already_present | duplicate | skipped) with the row id; ids and reasons only.",
    payloadSchema: Type.Object({
      patientId: id,
      organizationId: id,
      extractionCommitId: id,
      lineOutcomes: Type.Array(
        Type.Union([
          Type.Object({
            candidateId: id,
            outcome: Type.Union([
              Type.Literal("created"),
              Type.Literal("already_present"),
              Type.Literal("duplicate"),
            ]),
            recordId: id,
          }),
          Type.Object({ candidateId: id, outcome: Type.Literal("skipped"), reason: id }),
        ]),
      ),
      appliedAt: isoInstant,
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
];

/** Module 12's §4.4 outbox-event catalog contribution (the boot UPSERTs each into `outbox_event_catalog`). */
export const M12_OUTBOX_EVENTS: ModuleEventContribution =
  M12_OUTBOX_ENTRIES as unknown as ModuleEventContribution;

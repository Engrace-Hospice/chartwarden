// apps/backend/src/modules/11-orders/events-by-m11.ts — Module 11's outbox-event contributions
// (M11-T07, spec §4.4). The full `m11.order.*` taxonomy keyed on M11's own tables, under the `m11.`
// namespace (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file for
// naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m11'), and valid declared consumers (real
// module ids). The canonical wire `eventName` published to the M1 dispatcher follows M1 §3.17
// (`m11.order.<entity>_<verb>`) and mirrors `M11_EVENT_NAMES` in @wardenx/types (the closed §4.4 set the
// lifecycle machine / verbal-timer / standing-spawner / discontinuation cascade / lab appliers may emit).
// This file adds the TypeBox `payloadSchema` + declared consumers the dispatcher validates each publish
// against (§4.4 catalog), so the "DB updated but the event never went out" failure mode is closed in the
// same transaction as the mutation (M1 §25.5/§25.6).
//
// Phase-1 boundary (§0): the events whose declared consumers are future-wave modules (M21 supply
// fulfillment — Wave F; M29 HL7 ORM^O01 — Wave H; M22 PDF render; M28 FHIR projection) are PUBLISHED now
// by M11 — the producer side ships, the consumer attaches when that module lands. That is the spec's
// deny-stub posture: M11 never calls those modules' routes; it only emits the typed outbox event.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const orderKind = Type.Union([
  Type.Literal("lab"),
  Type.Literal("dme"),
  Type.Literal("level_of_care_change"),
  Type.Literal("recertification"),
  Type.Literal("comfort_kit"),
  Type.Literal("supply"),
  Type.Literal("ancillary_service"),
  Type.Literal("idg_requested"),
]);
const hl7Priority = Type.Union([
  Type.Literal("R"),
  Type.Literal("S"),
  Type.Literal("A"),
  Type.Literal("T"),
]);
// §2.8 D14 — the polymorphic verbal-order/signature discriminator (mirrors the DB's
// `order_signature_target_kind` enum): 'order' → the M11 `order_record` timer; 'medication_order' → an M12
// `medication_order` recorded through M11's published OrderSignatureProvider seam.
const orderSignatureTargetKind = Type.Union([
  Type.Literal("order"),
  Type.Literal("medication_order"),
]);

// The §4.4 pinned `m11.order.hl7_orm_requested` payload (M11 produces, M29 consumes). Mirrors the
// `OrmRequestedPayload` interface in @wardenx/types — the contract shared with the T-29.08 ORM builder.
// Demographics are INTENTIONALLY MINIMAL (no SSN / NK1 / IN1 / GT1 per the T-29.08 §3.6 PHI denylist).
// F-181 (#248) — exported so the M11 producer can `Value.Check` its payload BEFORE publishing: a payload the
// catalog refuses would otherwise throw out of the sign transaction and block signing the order itself.
export const ormRequestedPayloadSchema = Type.Object({
  orderId: id,
  organizationId: id,
  labDestinationFacilityId: id,
  priority: hl7Priority,
  requestedAt: isoInstant,
  // F-184 — present only on an operator-attested re-dispatch (see `OrmRequestedPayload.redispatchAttestationId`).
  redispatchAttestationId: Type.Optional(id),
  labOrderPayload: Type.Object({
    orderId: id,
    patientId: id,
    placerOrderNumber: id,
    observationIdentifier: Type.Object({
      code: id,
      text: Type.String(),
      codingSystem: id,
    }),
    orderingProviderNpi: id,
    orderingProviderName: Type.Object({ family: Type.String(), given: Type.String() }),
    priority: hl7Priority,
    clinicalNotes: Type.Optional(Type.Array(Type.String())),
    patientDemographics: Type.Object({
      mrn: id,
      internalMrnAuthority: id,
      familyName: Type.String(),
      givenName: Type.String(),
      dateOfBirth: id,
      administrativeSex: Type.String(),
      addressLine1: Type.Optional(Type.String()),
      addressCity: Type.Optional(Type.String()),
      addressState: Type.Optional(Type.String()),
      addressPostal: Type.Optional(Type.String()),
    }),
  }),
});

export const M11_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── order authoring lifecycle (§2.2 / §4.4) ───────────────────────────────────────────────────────────
  {
    eventName: "m11.order.draft_created",
    moduleOwner: "m11",
    description: "`createDraft` inserted a draft `order_record`; M22 preps the order form.",
    payloadSchema: Type.Object({
      orderId: id,
      patientId: id,
      admissionId: id,
      kind: orderKind,
      drafterMembershipId: id,
    }),
    // F-176 (#248) — m22 REMOVED: M11's spec names only `.document_requested` for M22 and this payload carries no form
    // content; a render here would take the genesis-only `(order_record, orderId)` key and make the signed render an
    // `idempotent_skip`.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.signature_requested",
    moduleOwner: "m11",
    description:
      "`requestSignature` moved a draft to `pending_signature`; M36 notifies the ordering physician's inbox.",
    payloadSchema: Type.Object({
      orderId: id,
      kind: orderKind,
      orderingPhysicianMdmId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.verbal_received",
    moduleOwner: "m11",
    description:
      "`recordVerbalOrder` opened a `verbal_pending` order + `verbal_order` row with a 48h deadline (§2.3 D3); M36 DMs the physician and confirms with the recording RN.",
    payloadSchema: Type.Object({
      orderId: id,
      verbalOrderId: id,
      deadlineAt: isoInstant,
      orderingPhysicianMdmId: id,
      recordingMembershipId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.cosign_requested",
    moduleOwner: "m11",
    description:
      "`requestSignature` on an LPN-drafted order needing cosign (§2.5); M36 posts to the RN cosign queue.",
    payloadSchema: Type.Object({
      orderId: id,
      kind: orderKind,
      cosignerRoleNeeded: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.cosigned",
    moduleOwner: "m11",
    description:
      "`cosignOrder` attached the required cosignature (§2.5); M33 reports, M36 closes the queue item.",
    payloadSchema: Type.Object({
      orderId: id,
      cosignatureId: id,
      cosignerRole: id,
      cosignerMembershipId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.signed",
    moduleOwner: "m11",
    description:
      "`signOrder` / `signOnBehalf` finalized an order to `active`; the broad clinical-record fan-out (M21 if supply-kind, M22 form, M28 FHIR, M29 if lab, M30/M33 metrics).",
    payloadSchema: Type.Object({
      orderId: id,
      kind: orderKind,
      signatureId: id,
      signerMembershipId: id,
      signedAt: isoInstant,
      viaVerbal: Type.Boolean(),
    }),
    declaredConsumers: [
      // F-104 — M14's §4.5 D8 auto-close closes an `order`/`medication_order`-linked action item
      // on this event, and this list did not name m14, so `assertBindableAgainstCatalog` would
      // have refused the binding for three of the six D8 sources while accepting the other three.
      "m14",
      // F-153 (#248) — m21 removed: emitted from the SAME transaction as the more specific
      // `m11.order.supply_fulfillment_requested` (`emitDownstreamSignedEvent`, this file) for every
      // supply/dme/comfort_kit-kind order — the fact M21 actually needs, one hop downstream, and the
      // pair genuinely M21 cares about (still deferred there, blocked on the Location-resolution gap
      // `consumers/order-context.ts` documents). The F-117/F-101 co-emission shape a module over.
      // F-117 (#248) — m22 removed: `signOrder`/`signOnBehalf` also emits
      // `m11.order.document_requested` in the SAME transaction (orders-route-service-db.ts) —
      // the actual live-bound M22 render request. Declaring m22 here too was the same handshake
      // named twice.
      // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
      // F-141 (#248) — m29 removed: M29's own spec names only the specific
      // `m11.order.hl7_orm_requested` event (its rich PID/ORC/OBR/NTE payload), never the broader
      // `.signed` — redundant with the sibling event once it lands, the F-101 shape.
    ],
    // F-149 (#248) — m30 MOVED here from declaredConsumers, along with all seven of its M11 siblings
    // below: M30's own §1.1 relationship inventory states flatly "Outbox publication is the only
    // cross-module communication M30 performs at the boundary. M30 *calls* … M11 … reader seams as
    // in-process function calls" (docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:353) — M30
    // never subscribes to an upstream module's outbox. The order-completion/discontinuation-timeliness/
    // lab-transmission/results-lifecycle measures M11's own spec cites (§D14, line 2844) as the M30
    // destination are real but genuinely unbound one layer deeper than the catalog declaration: the
    // published `OrderProvider` seam (`packages/types/src/orders.ts`) has no `getOrderCompletionRate`
    // and no transmission/results method at all — only `getOrdersSince`/`getDiscontinuationReason`/
    // `getVerbalOrderTimeliness` — and `OPERATIONAL_BOUND_MEASURE_CODES`
    // (`apps/backend/src/modules/30-quality/jobs/m30-jobs.ts`) currently registers none of these order
    // measures. "Bound is not computing" (F-042) one further step back: not even bound.
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.signed_on_behalf",
    moduleOwner: "m11",
    description:
      "`signOnBehalf` (medical_director only) signed for another practitioner; M4 emphasizes the audit, M30/M33 measure.",
    payloadSchema: Type.Object({
      orderId: id,
      signerMembershipId: id,
      onBehalfOfMembershipId: id,
      reason: Type.String(),
    }),
    // F-149 (#248) — m30 MOVED to seamConsumers, same basis as `.signed` above.
    declaredConsumers: [],
    seamConsumers: ["m4", "m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.verbal_signed_in_time",
    moduleOwner: "m11",
    description:
      "`signOrder` against a `verbal_pending` order before the 48h deadline (§2.3); M30 reads the on-time compliance metric (418.104).",
    payloadSchema: Type.Object({
      orderId: id,
      verbalOrderId: id,
      signedAt: isoInstant,
      hoursBeforeDeadline: Type.Number(),
    }),
    // F-115 (#248) — m30 moved to seamConsumers: reads verbal-order timeliness via
    // `VerbalTimelinessCountsView.getVerbalTimelinessCountsForOrg` (verbal_order_signature_on_time) on
    // its nightly cadence — same for `verbal_expired_unsigned` just below.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.verbal_expired_unsigned",
    moduleOwner: "m11",
    description:
      "The `verbal-order-expiry-worker` (§2.3/§2.6, the `orders.verbal_timer` cron) flipped a `verbal_pending` verbal_order row past its 48h deadline to `expired_unsigned` — `targetKind='order'` for an M11 `order_record`, `targetKind='medication_order'` for an M12 `medication_order` (§2.8 D14, the polymorphic `verbal_order` table); M36 raises the high-severity alert, M30 counts the 418.104(b) violation.",
    payloadSchema: Type.Object({
      orderId: id,
      verbalOrderId: id,
      // Added (previously absent) — the polymorphic discriminator M12's own `decideVerbalExpiry` decider
      // has always needed to tell an M11 order from an M12 medication order apart; the event could not
      // previously be delivered to a real M12 consumer because nothing on the wire said which table
      // `orderId` names. Additive on a never-actually-emitted event — see the worker header for why.
      targetKind: orderSignatureTargetKind,
      expiredAt: isoInstant,
      hoursOverdue: Type.Number(),
      orderingPhysicianMdmId: id,
    }),
    // F-115 (#248) — m30 moved to seamConsumers (same `getVerbalTimelinessCountsForOrg` seam).
    // F-143 (#248) — m12 ADDED: this event IS `M12_OUTBOX_SUBSCRIPTIONS`'s own entry for
    // `m12.verbal-expired`, backed by a real pure decider (`decideVerbalExpiry`,
    // consumers/verbal-expired.ts) — genuinely undeclared until now.
    declaredConsumers: ["m12"],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.discontinued",
    moduleOwner: "m11",
    description:
      "`discontinueOrder` or the discharge cascade wrote an `order_discontinuation` row and flipped the order to `discontinued` (§2.6 D13); broad close-out fan-out.",
    payloadSchema: Type.Object({
      orderId: id,
      discontinuationId: id,
      reason: id,
      actorMembershipId: Type.Union([id, Type.Null()]),
      effectiveAt: isoInstant,
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-129 (#248) — m14 added: M14's own `consumers/index.ts` and §4.5 spec table have named this event
    // (the "since last IDG" projection-cache update) since M14-T06; this catalog simply never declared it,
    // which would have made a future live binding fail `assertBindableAgainstCatalog` outright.
    // F-144 (#248) — m22 REMOVED: not in M22's own §4.11 consumer table, and no code path co-emits a
    // `document_requested` sibling for a discontinuation (`discontinueOrder`/the discharge cascade emit
    // only this event) — unsupported by any M22-side evidence.
    // F-149 (#248) — m30 MOVED to seamConsumers (the `.signed` finding above — M30 never subscribes to
    // an M11 outbox event; this fact would arrive, if ever bound, via the unbuilt order-completion seam).
    declaredConsumers: ["m14", "m21"],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.completed",
    moduleOwner: "m11",
    description:
      "`completeOrder` (manual clinician review or system one-shot auto-complete) finished an active order.",
    payloadSchema: Type.Object({
      orderId: id,
      completedAt: isoInstant,
      kindAutoOrManual: Type.Union([Type.Literal("auto"), Type.Literal("manual")]),
    }),
    declaredConsumers: [
      // F-104 — M14's §4.5 D8 auto-close closes an `order`/`medication_order`-linked action item
      // on this event, and this list did not name m14, so `assertBindableAgainstCatalog` would
      // have refused the binding for three of the six D8 sources while accepting the other three.
      "m14",
      // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    ],
    // F-149 (#248) — m30 MOVED to seamConsumers, same basis as `.signed` above.
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.corrected",
    moduleOwner: "m11",
    description:
      "`correctOrder` (via the supersede trigger, §164.526) created a replacement `order_record` and discontinued the original.",
    payloadSchema: Type.Object({
      newOrderId: id,
      replacedOrderId: id,
      kind: orderKind,
      drafterMembershipId: id,
    }),
    // F-144 (#248) — m22 REMOVED: not in M22's own §4.11 consumer table; `correctOrder`
    // (`orders-route-service-db.ts`) emits only this event, no `document_requested` sibling.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── kind-specific signed handshakes (§4.4 / regulatory drivers) ───────────────────────────────────────
  {
    eventName: "m11.order.level_of_care_change_signed",
    moduleOwner: "m11",
    description:
      "A signed `level_of_care_change` order (§418.108); M6 ends the prior LCP and starts the new one (M11 never writes `level_of_care_period`), M30 follows.",
    payloadSchema: Type.Object({
      orderId: id,
      fromLevel: id,
      toLevel: id,
      effectiveAt: isoInstant,
      admissionId: id,
    }),
    // F-136 (#248) — m23 REMOVED: "M23 follows" describes the downstream effect of M6's OWN re-emission
    // (this event's own description says M6 ends/starts the LCP), not a direct subscription — the fact
    // M23 actually needs arrives as the already-bound `m6.loc.changed`, redundant with this upstream
    // order-signed trigger. M23's own §4.4/dependsOn text names only the M6 outbox catalog as consumed.
    // F-144 (#248) — m22 REMOVED, checked against the same standard as the m23 removal above: M11's own
    // "Done means" walkthrough claims "M22 renders the LOC-change form" off M6's downstream
    // `m6.loc.changed` — but that event's own catalog entry (events-by-m6.ts) already carries a standing
    // F-101 finding that no such M22 template exists (`PLATFORM_TEMPLATE_TABLE` has no LOC-change entry)
    // and `m6.loc.changed` correctly still defers only on m23. This upstream order-signed event has no
    // stronger claim than the downstream one already refuted.
    // F-149 (#248) — m30 MOVED to seamConsumers, same basis as `.signed` above.
    declaredConsumers: ["m6"],
    seamConsumers: ["m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.recertification_signed",
    moduleOwner: "m11",
    description:
      "A signed `recertification` order (§418.22, W-RC-01); M6's CTI service validates F2F + CTI narrative then sequences the next benefit period. M11 does NOT validate F2F/CTI.",
    payloadSchema: Type.Object({
      orderId: id,
      admissionId: id,
      periodEndDate: id,
      certifyingPhysicianMdmId: id,
    }),
    // F-136 (#248) — m23 REMOVED: M6's own resulting `m6.cti.signed` / `m6.election.period_started`
    // (both already bound live) carry the fact M23 needs; this upstream order-signed event is redundant
    // with them, the same shape as `.level_of_care_change_signed` above.
    // F-144 (#248) — m22 REMOVED, redundant with the same downstream event: `m6.cti.signed` already
    // declares `m22` (bound to the `cti` template per M22's own §4.11 table) — this upstream
    // order-signed event carries nothing the downstream signal does not.
    declaredConsumers: ["m6"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.supply_fulfillment_requested",
    moduleOwner: "m11",
    description:
      "A signed `dme` / `supply` / `comfort_kit` order requests fulfillment; M21 (Wave F) fulfills. M11 emits the typed event today and never writes M21 tables (deny-stub consumer until M21 lands).",
    payloadSchema: Type.Object({
      orderId: id,
      kind: orderKind,
      supplyDetail: Type.Unknown(),
      preferredDeliveryWindow: Type.Optional(Type.Union([id, Type.Null()])),
      deploymentSite: Type.Optional(Type.Union([id, Type.Null()])),
    }),
    // F-144 (#248) — m22 REMOVED: redundant sibling — `signInternal` co-emits
    // `m11.order.document_requested` unconditionally for every signed order (all kinds, including
    // dme/supply/comfort_kit), already M22's real live-bound `order_record` render trigger.
    declaredConsumers: ["m21"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.supply_cancellation_requested",
    moduleOwner: "m11",
    description:
      "`discontinueOrder` on a supply-kind order whose M21 fulfillment was in-flight; M21 (Wave F) cancels.",
    payloadSchema: Type.Object({
      orderId: id,
      originalSupplyRequestRef: Type.Optional(Type.Union([id, Type.Null()])),
    }),
    declaredConsumers: ["m21"],
    isOutboxOnly: true,
  },
  // ── external lab transmission + results lifecycle (§4.4 / §4.10 — M29 forward seam, Wave H) ─────────────
  {
    eventName: "m11.order.hl7_orm_requested",
    moduleOwner: "m11",
    description:
      "A signed `kind='lab'` order requests outbound HL7 ORM^O01; M29 (Wave H) transports per-feed and retries per its own policy. M11 emits the pinned `OrmRequestedPayload` and never retries (deny-stub consumer until M29 lands).",
    payloadSchema: ormRequestedPayloadSchema,
    declaredConsumers: ["m29"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.transmission_status_changed",
    moduleOwner: "m11",
    description:
      "`LabTransmissionApplier` recorded an M29 wire-level transition (transmitted / pending_retry / failed); M30 dashboards, M33 reports.",
    payloadSchema: Type.Object({
      orderId: id,
      organizationId: id,
      fromStatus: id,
      toStatus: id,
      ackCode: Type.Optional(id),
      failureReason: Type.Optional(id),
      sourceM29EventId: id,
    }),
    // F-149 (#248) — m30 MOVED to seamConsumers, same basis as `.signed` above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.transmission_terminal_failed",
    moduleOwner: "m11",
    description:
      "`LabTransmissionApplier` saw an M29 terminal failure (willRetry=false, D16); M36 raises the high-severity ordering-provider alert.",
    payloadSchema: Type.Object({
      orderId: id,
      organizationId: id,
      failureReason: id,
      transmittedAttempts: Type.Integer({ minimum: 0 }),
      lastAttemptAt: isoInstant,
      orderingPhysicianMdmId: id,
    }),
    // F-149 (#248) — m30 MOVED to seamConsumers, same basis as `.signed` above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.results_received",
    moduleOwner: "m11",
    description:
      "`LabResultsApplier` bound a returned lab observation (D17 — does NOT auto-complete the order); M22 renders the results PDF, M28 projects a FHIR DiagnosticReport (F-115/#248: at request time, not via this event).",
    payloadSchema: Type.Object({
      orderId: id,
      organizationId: id,
      observationId: id,
      attachmentKind: Type.Union([Type.Literal("full"), Type.Literal("partial")]),
      orderingPhysicianMdmId: id,
      signedAt: isoInstant,
    }),
    declaredConsumers: ["m22"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.results_received_critical",
    moduleOwner: "m11",
    description:
      "`LabResultsApplier` saw M29-flagged critical observation values; M36 surfaces the critical-results chart-banner queue.",
    payloadSchema: Type.Object({
      orderId: id,
      organizationId: id,
      observationId: id,
      criticalFlags: Type.Array(Type.String()),
      orderingPhysicianMdmId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.results_overdue",
    moduleOwner: "m11",
    description:
      "The `lab-results-overdue-sweep` worker flipped an order awaiting results past its expected-by timestamp (D18); M36 raises the medium-severity alert.",
    payloadSchema: Type.Object({
      orderId: id,
      organizationId: id,
      expectedByAt: isoInstant,
      hoursOverdue: Type.Number(),
      orderingPhysicianMdmId: id,
    }),
    // F-149 (#248) — m30 MOVED to seamConsumers, same basis as `.signed` above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m36"],
    isOutboxOnly: true,
  },
  // ── IDG intake (§4.4 / W-IDG-01 — M14 forward seam) ───────────────────────────────────────────────────
  {
    eventName: "m11.order.idg_drafted",
    moduleOwner: "m11",
    description:
      "The `idg-decision-intake` consumer created a draft `kind='idg_requested'` order from an M14 decision; M36 notifies the RN case manager + IDG coordinator.",
    payloadSchema: Type.Object({
      orderId: id,
      triggeringIdgDecisionId: id,
      kindHint: Type.Literal("idg_requested"),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── standing orders (§2.4 D5) ─────────────────────────────────────────────────────────────────────────
  {
    eventName: "m11.order.standing_created",
    moduleOwner: "m11",
    description:
      "`createTemplate` registered a standing-order template with a spawn cadence (§2.4 D5).",
    payloadSchema: Type.Object({
      standingOrderId: id,
      patientId: id,
      admissionId: id,
      kind: orderKind,
      cadence: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.standing_spawned",
    moduleOwner: "m11",
    description:
      "`spawnScheduled` (cron) or `spawnFromTemplate` (PRN) minted a `standing_order_instance` + the spawned `order_record`.",
    payloadSchema: Type.Object({
      standingOrderId: id,
      instanceId: id,
      orderId: id,
      spawnedBy: id,
    }),
    // F-117 (#248) — m22 removed: the spawn path also emits `m11.order.document_requested` for
    // the spawned order in the same transaction (`spawnScheduled`/`spawnFromTemplate`), the
    // actual live-bound M22 render request — the same redundant declaration as `order.signed`.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.standing_discontinued",
    moduleOwner: "m11",
    description:
      "`discontinueTemplate` ended a standing-order template (active spawned instances continue per §2.6).",
    payloadSchema: Type.Object({
      standingOrderId: id,
      reason: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── render + UI-banner signals (§4.4) ─────────────────────────────────────────────────────────────────
  {
    eventName: "m11.order.document_requested",
    moduleOwner: "m11",
    description:
      "Mirror of `m11.order.signed` for the M22 form/PDF render handshake (§4.4 form rendering handshake).",
    payloadSchema: Type.Object({
      orderId: id,
      formTemplate: id,
      renderPayload: Type.Unknown(),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.verbal_expiring_soon",
    moduleOwner: "m11",
    description:
      "The `verbal-pre-expiry-alert` worker reached a pre-expiry tier (12h / 2h) on a `verbal_pending` order (§2.3); M36 escalates.",
    payloadSchema: Type.Object({
      orderId: id,
      verbalOrderId: id,
      hoursUntilDeadline: Type.Number(),
      severity: Type.Union([Type.Literal("medium"), Type.Literal("high")]),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m11.order.suggestion_state_changed",
    moduleOwner: "m11",
    description:
      "The `assessment-trigger` / `hope-trigger` consumers updated the per-patient order-suggestion banner state (§2.7 D7 — derived, no `order_suggestion` table); M36 fires the per-patient chart-banner refresh.",
    payloadSchema: Type.Object({
      patientId: id,
      addedSuggestions: Type.Array(Type.String()),
      droppedSuggestions: Type.Array(Type.String()),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    // ALSO live: server → patient room chart-banner refresh (§2.7 / §4.4 chart-banner cache).
    isOutboxOnly: false,
  },
];

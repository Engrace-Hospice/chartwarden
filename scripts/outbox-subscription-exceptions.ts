// scripts/outbox-subscription-exceptions.ts — the F-094 (#205) register of subscriptions a module
// DECLARES and the boot event catalog does not route to it.
//
// Six modules publish an `M<N>_SUBSCRIBED_EVENT_NAMES` constant, and each says the same thing about why:
// "Listed here — not only in the worker files — so the consumer wiring and the §9 tests share one source
// of truth, and so an upstream rename breaks the build rather than silently orphaning a handler."
// Nothing compared any of them to anything. Rule 6 of `check-outbox-bindings.ts` is that comparison, in
// both directions; this file is where a divergence that is CORRECT gets to say so.
//
// WHAT A DIVERGENCE COSTS. `declaredConsumers` is the relay's routing table. A name a module subscribes to
// and the catalog does not declare it on is an event the relay delivers to NOBODY in that module — and
// writing a binding does not help, because the dispatcher's own `assertBindableAgainstCatalog` refuses a
// binding whose module is not declared. That is the wall #204 hit: five of M20's six triggers were in its
// list and in no `declaredConsumers`, so the consumers could not have delivered anything even once
// written. An entry here is a claim that the cost is understood and is the right trade, and it has to say
// what would end it.
//
// THE OTHER DIRECTION NEEDS NO REGISTRY. A catalogued event that declares a module its list does not name
// is simply the list being wrong — the catalog is what the relay reads — so those were reconciled into the
// lists rather than excepted. 32 of the 65 original disagreements were that, including
// `idg.decision_recorded`, the one event M16 binds LIVE and its own subscription list did not name.
//
// GROUPED BY (module, kind) BECAUSE THAT IS WHERE THE REASON LIVES — M31's nine entries are one fact about
// M31, not nine facts — while the event lists stay exact so the count cannot drift. Both halves are
// checked: an entry that comes to agree in both directions fails ("outlived its reason"), and one where
// neither side names the pair any more fails too, so a reconciled exception cannot sit here unnoticed.
//
// KEYED ON THE PAIR, NEVER ON THE MODULE ALONE. A module-level exemption would let a module delete its
// list and silently stop being checked, which is the failure mode this whole gate family exists to end.

/**
 * Why the catalog does not route a subscribed event to the module that names it.
 *
 * There is deliberately no `deferred` or `todo` kind. Every value below states a fact about the CATALOG or
 * about the module's code that a reader can go and check; "we mean to get to it" is not a reason, it is
 * the absence of one.
 */
export type SubscriptionExceptionKind =
  /**
   * The event is in NO boot catalog entry because its owning module contributes none. Not a typo and not
   * a rename: there is no `M2_OUTBOX_EVENTS` and no `M36_OUTBOX_EVENTS`, so nothing can publish these
   * names and no `declaredConsumers` list can mention them. Ends when the owning module catalogues them.
   */
  | "no-producer"
  /**
   * The module has no consumer for this event — either no `consumers/` directory at all, or one that
   * decides on other topics. Declaring it would defer every emission forever (`resolveRouting` marks the
   * event `deferred`, the relay finalizes the row `pending` with `attemptCount - 1`, so it never
   * dead-letters and never purges) in exchange for a handler that does not exist. Ends when one does.
   */
  | "no-handler"
  /**
   * Every module currently declared on this event BINDS it, so the event is delivered and dispatched
   * today. Adding an unbound consumer would newly defer it — turning a working delivery into a row
   * re-claimed every thirty minutes for the life of the deployment, for every other consumer too. The
   * declaration must therefore land WITH the binding, never before it.
   */
  | "would-defer-a-bound-event"
  /**
   * The event is catalogued record-only (`declaredConsumers: []`) — the owning module publishes it for the
   * record and delivers it to nobody. Adding the first consumer changes what the event IS, which is the
   * owning module's decision and not the subscriber's to take unilaterally.
   */
  | "record-only-target"
  /**
   * The module subscribes to its OWN event. A `*_UPSTREAM_SUBSCRIPTIONS` map is by construction the
   * inbound half — what other modules send this one — so a self-consumed topic (a retry consumer, a
   * staged submit-request worker) is correctly absent from it while the catalog correctly declares it.
   * The two are describing different things, and the six `M<N>_SUBSCRIBED_EVENT_NAMES` tuples encode the
   * same convention: their tests assert no self-consumption. Ends only if a module stops self-consuming.
   */
  | "self-consumption"
  /**
   * The name is in NO boot catalog and its apparent owner DOES contribute one. Unlike `no-producer` this
   * is not a staging gap that time will close — the owning module has catalogued its events and this is
   * not among them, so the name was never right. It is kept, rather than deleted, when the SUBSCRIPTION
   * is meaningful and only the spelling is unknown: deleting it would erase the record that the module
   * expects this input, and guessing at the intended event would bind a handler to the wrong one. Ends
   * when the owning module catalogues the event or the intended name is established.
   */
  | "no-such-event"
  /**
   * The module HAS a decider for this event and no live binding for it, and the catalog does not declare
   * the module. Distinct from `no-handler`, which is the absence of the handler: here the handler is
   * written and bound by nothing, so this is #103's `handlers-unbound` set seen from the list side — and
   * it cannot appear in `outbox-deferred-consumers.ts`, which can only hold pairs the catalog DECLARES.
   *
   * Declaring the module without binding it would newly defer the event, so the corpus convention
   * (`events-by-m22.ts`: "DECLARED CONSUMERS ARE THE BOUND ONES, NOT THE INTERESTED ONES") is that the
   * declaration lands on the commit that binds the handler. Ends on that commit, in one change, both
   * halves together — which is exactly what #204 and #207 had to do for M20 and M19.
   */
  | "handler-unbound";

/** One module's subscribed-but-unrouted events that share a reason. */
export interface SubscriptionExceptionGroup {
  /** The module token whose `M<N>_SUBSCRIBED_EVENT_NAMES` names these events. */
  readonly module: string;
  readonly kind: SubscriptionExceptionKind;
  /** Why the divergence is correct, and what would end it. Must be non-empty. */
  readonly reason: string;
  /** Every subscribed event of this module the catalog does not route to it, for this reason. Exact. */
  readonly events: readonly string[];
}

export const SUBSCRIPTION_EXCEPTIONS: readonly SubscriptionExceptionGroup[] = [
  {
    module: "m16",
    kind: "record-only-target",
    reason:
      "GAP-130 re-checked all three against the producers' OWN specs and the architecture, which win over M16 §4.5. `m39.consent.created`: M39's own outbox table states its consumers as '(none — drafts are internal)'; M16's §4.5 post-death-grant handler ('enables previously proposed contacts to confirm') is REAL and LIVE on the event that actually carries that fact, `m39.consent.signed` (`buildM16ConsentSignedConsumer`, F-159) — a draft consent confirms nobody. `m4.legal_hold.applied/released`: architecture §24.3 ('retention jobs skip legal_hold records') and M4's own `routes/legal-holds.ts` + `events-by-m4.ts` (M04-F03) make a hold a READ at the point of destruction (`createDrizzleAuditEraserPorts.legalHoldFor`, M34's shred preflight), and propagation to an owning module is a registered `HoldApplier` SEAM, never an outbox subscription (the payload carries no criteria a subscriber could match a plan with). A hold does not change the 13-month program, only erasure, so M16's two dead plan transitions (`legalHoldApplied`/`legalHoldReleased`, no caller anywhere) were removed in the same change rather than left as a control on paper only. Ends only if M4 ships the `HoldApplier` seam and M16 registers one — not an outbox fix.",
    events: ["m39.consent.created", "m4.legal_hold.applied", "m4.legal_hold.released"],
  },
  // GAP-130 — the m16 `no-handler` (`m8.encounter.signed`) and `would-defer-a-bound-event`
  // (`m22.document.rendered`) groups are GONE: both are BOUND (`buildM16EncounterSignedConsumer`,
  // `buildM16DocumentRenderedConsumer`), with `m16` declared on each producer's catalog in the same change.
  {
    module: "m19",
    kind: "no-handler",
    reason:
      "M19's `consumers/` decides on the M17 no-show, the M18 late check-out, the M36 delivery-failure trigger and (GAP-058) `m8.encounter.signed` -> `documented`. These two are §4.8 triage-context inputs with no decider written; declaring them would defer events other modules are already waiting on and produce no handler. Ends with M19 Phase 2.",
    events: ["m5.patient.deceased", "m11.order.verbal_expired_unsigned"],
  },
  {
    module: "m31",
    kind: "record-only-target",
    reason:
      "F-139 (#248) re-checked this against M39's/M4's OWN spec text, not just the catalog shape. M39's own §4.10-equivalent outbox table states `consent.created`'s consumers as '(none — drafts are internal)' — a decisive first-party disclaimer, unlike M31's spec text which names it aspirationally; stays record-only, M31 not added. M4's own module spec (§M04-F03) is equally decisive the other way for the legal-hold pair: propagation is a registered `HoldApplier` SEAM per data-owning module (`applyHold`/`releaseHold`, the same pattern as `DataEraser`), never an outbox subscription — `events-by-m4.ts`'s own header says declaring a consumer here 'would be a namespace lie'. M31 registering a `HoldApplier` is real, unbuilt work, but it is not an outbox-catalog fix and does not belong in `outbox-deferred-consumers.ts` either.",
    events: ["m39.consent.created", "m4.legal_hold.applied", "m4.legal_hold.released"],
  },
  {
    module: "m35",
    kind: "record-only-target",
    reason:
      "M5 catalogues both record-only. M35 counts billable patients off them, which would make M5's patient lifecycle a billing input — a coupling M5 has not agreed to and cannot be given by its subscriber.",
    events: ["m5.patient.created", "m5.patient.status_changed"],
  },
  // ── F-095 (#208): the thirteen modules rule 6 could not see until discovery stopped being a naming
  // convention in one directory. Same register, same rules; the three kinds below were added for facts
  // the original six lists never presented.
  {
    module: "m11",
    kind: "handler-unbound",
    reason:
      "`consumers/hope-trigger.ts` is a written decider whose only caller is its own test. The event is already deferred by other unbound consumers, so declaring `m11` costs nothing at runtime today — and the declaration still belongs on the commit that binds the handler, not before it. F-102 removed `m6.admission.discharged` from this entry by doing exactly that: `consumers/bindings.ts` now binds `decideDischargeCascade` and M6's catalog declares m11.",
    events: ["m10.hope.j2051_trigger_fired"],
  },
  {
    module: "m23",
    kind: "self-consumption",
    reason:
      "All seven are M23's OWN events, consumed by M23's `outbox-consumers/submit-requests.ts` outbox→BullMQ bridges (the five staged-submission topics — claim, claim retry, NOE, NOTR and the 8xC transfer notice — plus — GAP-070 — `validation_started` / `refresh_requested`, which feed the `validation-run` / `eligibility.refresh` workers). `M23_UPSTREAM_SUBSCRIPTIONS` is by construction the INBOUND half — what other modules send M23 — so a self-consumed topic is correctly absent from it while the catalog correctly declares it. The two describe different things.",
    events: [
      "m23.claim.submit_requested",
      "m23.claim.submission_failed",
      "m23.noe.submit_requested",
      "m23.notr.submit_requested",
      "m23.transfer_notice.submit_requested",
      "m23.claim.validation_started",
      "m23.eligibility.refresh_requested",
    ],
  },
  {
    module: "m23",
    kind: "handler-unbound",
    reason:
      "`consumers/handlers.ts` implements both effects — the `m8.encounter.signed` re-validate fan-out and the M26 cap-projection freeze — and nothing binds them. Both events are already deferred by other unbound consumers.",
    events: ["m8.encounter.signed", "m26.cap.projection_updated"],
  },
  {
    module: "m23",
    kind: "record-only-target",
    reason:
      "M40 catalogues `canonical.updated` record-only. M23 would freeze new-claim creation on a canonical provider change, which would make M40's reference-data lifecycle a billing input — M40's decision to grant, not M23's to take.",
    events: ["m40.canonical.updated"],
  },
  {
    module: "m23",
    kind: "would-defer-a-bound-event",
    reason:
      "Same fact as M14's: the render handshake dispatches today for its five bound consumers, and M23's NOE/NOTR/claim back-ref (`consumers/document-render.ts`) is written but unbound. The declaration must land on the commit that binds it.",
    events: ["m22.document.rendered"],
  },
  {
    module: "m24",
    kind: "self-consumption",
    reason:
      "M24's own staged submission topic, consumed by `consumers/submission-requests.ts`. The upstream map is the inbound half; see the M23 entry.",
    events: ["m24.medicaid_claim.submit_requested"],
  },
  {
    module: "m25",
    kind: "self-consumption",
    reason:
      "`m25.edi.835_received` is M25's own event and M25's `consumers/live-binding.ts` is the LIVE consumer of it — the one binding this module has. The upstream map is the inbound half, so it correctly does not list it.",
    events: ["m25.edi.835_received"],
  },
  {
    module: "m25",
    kind: "would-defer-a-bound-event",
    reason:
      "The appeal-packet / resolution-letter back-ref is `M25_SUBSCRIPTION_MAP`'s third effect and is bound by nothing, while the render handshake dispatches today for its five bound consumers.",
    events: ["m22.document.rendered"],
  },
  {
    module: "m27",
    kind: "handler-unbound",
    reason:
      "`consumers/handlers.ts` implements the denial-accrual effect and nothing binds it; the event is already deferred by other unbound consumers.",
    events: ["m25.denial.opened"],
  },
  {
    module: "m27",
    kind: "no-such-event",
    reason:
      "M40's landed catalog carries `canonical.updated` and `canonical.deactivated` and no provider-entity offboarding topic. M27's §4.4 intent — close a cost report when its provider entity leaves — is real; the name is not.",
    events: ["m40.provider_entity.offboarded"],
  },
  {
    module: "m30",
    kind: "handler-unbound",
    reason:
      "`packages/quality/src/consumers/handlers.ts` implements the election-signed HCI denominator effect and nothing binds it. (`m6.discharge.death` left this group in GAP-089: its mortality half is bound by `m6-discharge-death.ts`.)",
    events: ["m6.election.signed"],
  },
  {
    module: "m33",
    kind: "handler-unbound",
    reason:
      "ONE decision, not fifty-four. `M33_MV_REFRESH_SUBSCRIPTIONS` is generated from `OUTBOX_INVALIDATING_TOPICS` — the map of which upstream event invalidates which `report_mv.*` materialized view — and the module's own `M33_MV_REFRESH_SUBSCRIPTIONS_DEFERRED = true` records that the subscriber is written and the dispatcher binding is not. This is the same fact as #103's 319-pair m33 group, which reaches the same conclusion from the catalog side. Declaring m33 on all of these before the binding exists would defer every one of them; the MV tier reads the views on its nightly cadence meanwhile.",
    events: [
      "m5.patient.created",
      "m6.discharge.created",
      "m6.admission.activated",
      "m6.admission.discharged",
      "m6.cti.signed",
      "m6.f2f.attested",
      "m7.care_plan.review_overdue",
      "m7.care_plan.version_signed",
      "m8.encounter.signed",
      "m8.encounter.late_entry_override",
      "m8.encounter.cosigned",
      "m9.assessment.recorded",
      "m10.hope.timepoint_signed",
      "m10.hope.j2051_trigger_fired",
      "m10.hope.submission_accepted",
      "m10.hope.submission_rejected",
      "m11.order.signed",
      "m11.order.verbal_expired_unsigned",
      "m12.medication_order.signed",
      "m12.medication_order.transmitted",
      "m13.administration.recorded",
      "m13.scheduled_dose.missed",
      "m15.aide_supervisory.completed",
      "m15.volunteer.ratio_recomputed",
      "m16.bereavement.outreach_completed",
      "m16.bereavement.outreach_missed",
      "m16.bereavement.risk_score_computed",
      "m17.visit.completed",
      "m17.visit.no_show_detected",
      "m17.route_optimized",
      "m18.evv.check_in_recorded",
      "m18.evv.check_out_recorded",
      "m18.evv.late_check_resolved",
      "m18.evv.aggregator_accepted",
      "m18.evv.aggregator_rejected",
      "m19.triage_call.opened",
      "m19.triage_call.closed",
      "m20.safety.incident_submitted",
      "m23.claim.submitted",
      "m23.claim.acknowledged",
      "m23.claim.paid",
      "m23.claim.denied",
      "m23.noe.window_breached",
      "m24.medicaid_claim.submitted",
      "m24.medicaid_claim.denied",
      "m25.remittance.claim_paid",
      "m25.denial.opened",
      "m25.appeal.submitted",
      "m26.cap.accrual_recorded",
      "m26.cap.projection_updated",
      "m26.cap.threshold_crossed",
      "m27.cost_report.created",
      "m27.cost_report.validation_completed",
      "m27.cost_report.submitted",
    ],
  },
  {
    module: "m33",
    kind: "no-such-event",
    reason:
      "M25's landed catalog carries `appeal.submitted` and no appeal DECISION topic — the outcome that `mv_appeal_outcomes_org_month` is keyed on is exactly the event M25 does not publish. The MV and its invalidation intent are real; the name is not.",
    events: ["m25.appeal.decided"],
  },
  {
    module: "m33",
    kind: "handler-unbound",
    reason:
      "M28 now catalogues `m28.fhir.bulk_export.completed` (events-by-m28.ts), and `packages/reporting/src/catalog/outbox-subscription-map.ts` already keys `mv_fhir_bulk_export_org_month` off this exact name — so the catalog entry documents the relationship via `seamConsumers: ['m33']`, not `declaredConsumers`, to avoid deferring the event forever the moment M33 lands its binding. The consumer-side mechanism (`packages/reporting/src/refresh/outbox-subscriber.ts`'s `handleUpstreamInvalidation`) is written and unit-tested but has no live `OutboxConsumerBinding` — `M33_MV_REFRESH_SUBSCRIPTIONS_DEFERRED = true` covers all ~60 of its topics, not just this one, so binding it is a separate M33 composition-root task spanning far more than M28. Ends when that binding lands.",
    events: ["m28.fhir.bulk_export.completed"],
  },
  {
    module: "m34",
    kind: "self-consumption",
    reason:
      "M34's own provisioning topic, consumed by `outbox-consumers/provision-started.ts`. `M34_DSAR_BACKREF_SUBSCRIPTION` declares the single INBOUND subscription (the M22 render back-ref) and correctly says nothing about M34's own events.",
    events: ["m34.tenant.provision_started"],
  },
  {
    module: "m34",
    kind: "would-defer-a-bound-event",
    reason:
      "The DSAR-bundle back-ref consumer is written (`packages/saas-tenant-platform/src/consumers/m22-document-backref.ts`) and bound by nothing, while the render handshake dispatches today for its five bound consumers.",
    events: ["m22.document.rendered"],
  },
];

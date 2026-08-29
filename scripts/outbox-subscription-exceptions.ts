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
  | "record-only-target";

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
      "M4 catalogues both legal-hold topics record-only and M39 does the same for `consent.created`: each is published for the audit record and delivered to nobody. M16 wants them to pause a bereavement plan's purge and to seed an outreach consent, but the hold state is a READ at erase time (M34's `hold-discovery` is the working path) rather than an event, so the first consumer on these is M4's and M39's decision to make.",
    events: ["m39.consent.created", "m4.legal_hold.applied", "m4.legal_hold.released"],
  },
  {
    module: "m16",
    kind: "no-handler",
    reason:
      "M16's `consumers/` decides on `m6.bereavement.eligible` and `m6.discharge.cosigned` and nothing else. `m8.encounter.signed` is a §4.5 risk-scoring input with no decider written, and declaring it would defer an event eight other modules are already waiting on rather than produce a handler. Ends with M16-T06's §4.9 workers.",
    events: ["m8.encounter.signed"],
  },
  {
    module: "m16",
    kind: "would-defer-a-bound-event",
    reason:
      "`m22.document.rendered` is delivered TODAY: all five declared consumers (m11, m12, m13, m21, m33) bind their document back-refs live. M16's own back-ref — the outreach artifact M22 renders for a bereavement plan — has no consumer, so declaring `m16` would stop the event dispatching for the other five as well. The declaration must land in the same change as the binding.",
    events: ["m22.document.rendered"],
  },
  {
    module: "m19",
    kind: "no-producer",
    reason:
      "M36 contributes NO event catalog to the boot dispatcher — there is no `M36_OUTBOX_EVENTS` in `buildBootOutboxCatalog([...])` and no `events-by-m36.ts` in the repo — so this topic has no producer under this or any other name. M19's `consumers/m36-delivery-failed.ts` is a written decider waiting on it, and M20 carries a matching `delivery_failed` SOS escalation reason, so the subscription is kept as the record that the integration is intended. Ends when M36 catalogues its notification events.",
    events: ["m36.notification.delivery_failed"],
  },
  {
    module: "m19",
    kind: "no-handler",
    reason:
      "M19's `consumers/` decides on the M17 no-show, the M18 late check-out and the (unproducible) M36 delivery failure. These three are §4.8 triage-context inputs with no decider written; declaring them would defer events other modules are already waiting on and produce no handler. Ends with M19 Phase 2.",
    events: ["m5.patient.deceased", "m8.encounter.signed", "m11.order.verbal_expired_unsigned"],
  },
  {
    module: "m20",
    kind: "no-producer",
    reason:
      "Same absence as M19's: M36 catalogues no events, so `m36.notification.delivery_failed` cannot be published. M20 keeps the subscription because `lifecycle/sos-alert.ts` defines a `delivery_failed` SOS escalation reason for exactly it — 'a page that did not arrive is a breach' — which is the record that this rung of the D4 ladder is designed and unreachable.",
    events: ["m36.notification.delivery_failed"],
  },
  {
    module: "m20",
    kind: "no-handler",
    reason:
      "`consumers/index.ts` names this one explicitly as M20-T06's, out of scope for the M17/M18 binding #204 landed: a patient death closes that patient's visits, and the safety obligations attached to them, through a consumer that is not written. Declaring it now would defer an event M16, M23 and M28 are already waiting on.",
    events: ["m5.patient.deceased"],
  },
  {
    module: "m31",
    kind: "record-only-target",
    reason:
      "M39 catalogues `consent.created` record-only and M4 does the same for both legal-hold topics — published for the record, delivered to nobody. M31 would use them to gate portal access and to freeze a portal eraser, but adding the first consumer to a record-only event is the owning module's decision, and M31 has no consumer surface to put behind it.",
    events: ["m39.consent.created", "m4.legal_hold.applied", "m4.legal_hold.released"],
  },
  {
    module: "m31",
    kind: "no-handler",
    reason:
      "M31 has NO `consumers/` directory at all (`outbox-deferred-consumers.ts` files it `no-consumer-surface`), so its §4.10 list is an intent rather than a running subscription. Each of these events is already deferred by another unbound consumer, so declaring `m31` would cost nothing at runtime today — and would still be a declaration with no handler behind it, which is what this register exists to stop being silent about. Ends when M31 grows a consumer surface.",
    events: [
      "m6.admission.discharged",
      "m16.bereavement.plan_closed_completed",
      "m16.bereavement.plan_opened",
      "m39.consent.revoked",
    ],
  },
  {
    module: "m31",
    kind: "would-defer-a-bound-event",
    reason:
      "Both are delivered TODAY — `m17.visit.published` to m8, m18 and m20 (all bound as of #204) and `m22.document.rendered` to all five of its consumers. M31 has no consumer surface, so declaring it would convert two working deliveries into rows re-claimed every thirty minutes, for every other consumer as well. These two declarations must land in the same change as M31's bindings.",
    events: ["m17.visit.published", "m22.document.rendered"],
  },
  {
    module: "m35",
    kind: "no-producer",
    reason:
      "M2 contributes NO event catalog to the boot dispatcher — there is no `M2_OUTBOX_EVENTS` — so none of the four organization/session lifecycle topics M35's §4.12 per-seat billing is specified against can be published. This is half of M35's entire subscription list. The absence is M2's to close; M35 keeps the names because the seat-count, suspension and dunning logic are written against them.",
    events: [
      "m2.organization.activated",
      "m2.organization.closed",
      "m2.organization.suspended",
      "m2.session.created",
    ],
  },
  {
    module: "m35",
    kind: "record-only-target",
    reason:
      "M5 catalogues both record-only. M35 counts billable patients off them, which would make M5's patient lifecycle a billing input — a coupling M5 has not agreed to and cannot be given by its subscriber.",
    events: ["m5.patient.created", "m5.patient.status_changed"],
  },
  {
    module: "m35",
    kind: "no-handler",
    reason:
      "M35 has no `consumers/` directory. Both events are already deferred by other unbound consumers, so declaring `m35` would cost nothing today and would still be a declaration with nothing behind it. Ends when M35 grows a consumer surface.",
    events: ["m5.patient.deceased", "m5.patient.merged"],
  },
];

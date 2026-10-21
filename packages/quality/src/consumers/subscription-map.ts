import type { IncidentKind } from "../contracts";
// @chartwarden/quality · consumers — the §4.10 UPSTREAM outbox-subscription map (the M30 inbound catalog).
//
// M30 is not only an event PRODUCER (events-by-m30.ts) — it also SUBSCRIBES to a small set of upstream
// topics and projects each into an M30-local effect (a row-draft to insert, or a debounced measure-
// recompute to enqueue). This module is the SINGLE SOURCE OF TRUTH for that topic→effect fan-out, the
// exact mirror of M33's `catalog/outbox-subscription-map.ts`: the pure handlers in `./handlers.ts` read
// THIS map, and the boot dispatcher (a later platform phase, RULE 3(d)) forward-declares one consumer
// binding per subscribed topic.
//
// PURE DATA. No I/O, no DB — a frozen lookup table the handlers + the §4.10 fan-out test read. Keys are
// upstream topic strings (`mN.<entity>.<event>`); values are the ordered list of M30 effects that topic
// triggers. Cross-module communication here is outbox-ONLY: M30 never imports M5–M23 internals (the
// dependency-cruiser blocks it); the topic STRING + the structurally-minimal payload shape is the entire
// contract (no new manifest `dependsOn` edge). A subscribed topic carrying MULTIPLE effects (a death both
// drafts a mortality review AND seeds the next CAHPS sample) lists them in deterministic order.
import type { MeasureFamily } from "../measures/registry";

/**
 * One M30 effect a delivered upstream event projects to (§4.10). Discriminated by `kind` so a new effect
 * is an additive case; every variant carries a human `note` (the §4.10 subscriber-table cell) for the
 * fan-out test + the catalog's reporting surface.
 */
export type M30SubscriptionEffect =
  /** Enqueue a debounced measure recompute for every measure in the named families (the §3.3 work list). */
  | {
      readonly kind: "recompute";
      /** The measure families whose values the upstream event dirties (HCI / HOPE-derived / …). */
      readonly families: readonly MeasureFamily[];
      readonly note: string;
    }
  /** Auto-create a `mortality_review` draft from the death event (the §4.12 / §7.13 genesis). */
  | { readonly kind: "mortality_review_draft"; readonly note: string }
  /** Seed the decedent into the next monthly CAHPS sample candidate set (the §4.13 / WF-04 feed). */
  | { readonly kind: "cahps_candidate_add"; readonly note: string }
  /** Auto-create a `draft` `incident_report` of the named kind (the §4.10 / D8 auto-incident path). */
  | { readonly kind: "incident_draft"; readonly incidentKind: IncidentKind; readonly note: string }
  /** Recompute HVLDL when the verified visit sits within ±`windowDays` of a decedent's death (§4.10). */
  | {
      readonly kind: "hvldl_near_death_recompute";
      readonly windowDays: number;
      readonly note: string;
    };

/**
 * The §4.10 catalog: upstream outbox topic → the ordered M30 effects it triggers. Frozen so no consumer
 * can mutate it. The handlers in `./handlers.ts` read this map; the boot dispatcher forward-declares one
 * binding per key (the `M30_UPSTREAM_SUBSCRIPTIONS` list below).
 */
export const M30_OUTBOX_SUBSCRIPTIONS: Readonly<Record<string, readonly M30SubscriptionEffect[]>> =
  Object.freeze({
    // ── M6 admission lifecycle ──────────────────────────────────────────────────────────────────────
    "m6.discharge.death": [
      {
        kind: "mortality_review_draft",
        note: "Every patient death auto-creates a `mortality_review` draft (§4.12 / §7.13).",
      },
      {
        kind: "cahps_candidate_add",
        note: "The decedent is added to the next monthly CAHPS sample candidate set (§4.13 / WF-04).",
      },
    ],
    "m6.election.signed": [
      {
        kind: "recompute",
        families: ["hci"],
        note: "A new hospice election shifts the HCI denominators — enqueue an HCI recompute.",
      },
    ],

    // ── M10 HOPE ────────────────────────────────────────────────────────────────────────────────────
    "m10.hope.submission_accepted": [
      {
        kind: "recompute",
        families: ["hope_derived"],
        note: "An accepted HOPE submission feeds the timely-follow-up (TFP) measures — enqueue a recompute.",
      },
    ],

    // ── M16 bereavement ─────────────────────────────────────────────────────────────────────────────
    // F-160-follow-up (#248) — narrower than the `recompute` variant's own `families` field implies: the
    // handler (`./handlers.ts` `handleBereavementPlanClosed`) enqueues ONLY `bereavement_coverage_rate`
    // by explicit code, not every measure in the `operational` family — see that handler's doc comment
    // for why (the real dependency is the `cancel_future_outreach` effect on `bereavement_outreach`, not
    // the dormant `planClosureCounts`/`riskScreeningCompletenessCounts` seam methods).
    "m16.bereavement.plan_closed_completed": [
      {
        kind: "recompute",
        families: ["operational"],
        note: "A closed plan cancels future outreach touchpoints, shrinking the CoP 418.64(d) coverage denominator — enqueue bereavement_coverage_rate.",
      },
    ],
    "m16.bereavement.plan_closed_declined": [
      {
        kind: "recompute",
        families: ["operational"],
        note: "Same as plan_closed_completed — closeOnAllContactsOptedOut also cancels future outreach.",
      },
    ],
    "m16.bereavement.plan_closed_early": [
      {
        kind: "recompute",
        families: ["operational"],
        note: "Same as plan_closed_completed — closeEarly also cancels future outreach.",
      },
    ],

    // ── M12 medication orders ───────────────────────────────────────────────────────────────────────
    "m12.medication.error_reported": [
      {
        kind: "incident_draft",
        incidentKind: "medication_error",
        note: "A reported medication error auto-files a `medication_error` incident draft (D8, medicationOrderId populated).",
      },
    ],

    // ── M37 IPU restraints ──────────────────────────────────────────────────────────────────────────
    "m37.restraint.applied": [
      {
        kind: "incident_draft",
        incidentKind: "restraint_use",
        note: "A restraint application auto-files a `restraint_use` incident draft (F-185, D8, thin-pointer payload: restraintEventId + restraintKind).",
      },
    ],

    // ── M18 EVV ─────────────────────────────────────────────────────────────────────────────────────
    "m18.evv.visit_verified": [
      {
        kind: "hvldl_near_death_recompute",
        windowDays: 3,
        note: "A verified visit within ±3 days of a death re-feeds HVLDL — enqueue an HVLDL recompute.",
      },
    ],

    // ── M23 billing — Medicare ──────────────────────────────────────────────────────────────────────
    "m23.claim.adjudicated": [
      {
        kind: "recompute",
        families: ["hci"],
        note: "An adjudicated claim resolves the HCI claims-derived indicators — enqueue an HCI recompute.",
      },
    ],
  });

/** Every upstream topic M30 subscribes to (the §4.10 inbound set). */
export const M30_OUTBOX_SUBSCRIPTION_TOPICS: readonly string[] = Object.freeze(
  Object.keys(M30_OUTBOX_SUBSCRIPTIONS),
);

/**
 * The ordered M30 effects a delivered upstream topic projects to (the handlers' fan-out lookup). Returns
 * an EMPTY array for an unknown topic — a deliberate no-op, never an error (M30 tolerates upstream
 * emitting events it does not map, exactly as M33's `mvKeysForTopic` does).
 */
export function effectsForTopic(topic: string): readonly M30SubscriptionEffect[] {
  return M30_OUTBOX_SUBSCRIPTIONS[topic] ?? [];
}

// ── forward-declared subscription bindings (the boot dispatcher wires these; RULE 3(d) defers the rail) ──

/** The shared consumer name every M30 upstream binding registers under. Consumer dedup is keyed
 *  `(eventId, consumerName)` per the M1 outbox-consumer pattern (the M22/M33/M34 precedent). */
export const M30_UPSTREAM_CONSUMER_NAME = "m30.upstream-consumer" as const;

/** One forward-declared `{ eventName, consumerName }` binding (the M33 `MvRefreshSubscription` shape) the
 *  boot dispatcher wires once the live inbound transactional-outbox dispatcher accessor lands (RULE 3(d)). */
export interface M30UpstreamSubscription {
  readonly eventName: string;
  readonly consumerName: typeof M30_UPSTREAM_CONSUMER_NAME;
}

/** Every subscribed §4.10 topic, forward-declared as a consumer binding. */
export const M30_UPSTREAM_SUBSCRIPTIONS: readonly M30UpstreamSubscription[] =
  M30_OUTBOX_SUBSCRIPTION_TOPICS.map((eventName) => ({
    eventName,
    consumerName: M30_UPSTREAM_CONSUMER_NAME,
  }));

/** DEFERRED until the live inbound transactional-outbox dispatcher exists in bootstrap (RULE 3(d), the M33
 *  `*_DEFERRED` precedent). The consumers ship PURE + this subscription map; no running subscriber boots. */
export const M30_UPSTREAM_SUBSCRIPTIONS_DEFERRED = true as const;

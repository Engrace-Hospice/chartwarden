// apps/backend/src/modules/23-billing-medicare/consumers — the §4.4 / §4.10 / D3 UPSTREAM outbox-subscription
// map (the M23 inbound catalog). Mirrors the M27 `27-cost-report/consumers/subscription-map.ts` precedent.
//
// M23 is not only an event PRODUCER (events-by-m23.ts) — it SUBSCRIBES to a set of upstream topics and
// projects each into an M23-local effect (spec §4.4 "the seams M23 consumes" + §10 tasks 47, 50, 53–57 +
// the §8 `m23.revalidate.consumer` worker table). This file is the SINGLE SOURCE OF TRUTH for that
// topic→effect fan-out; the pure handlers in `./handlers.ts` read THIS map, and the boot dispatcher (a later
// platform phase, RULE 3(d)) forward-declares one consumer binding per subscribed topic.
//
// PURE DATA. No I/O, no DB — a frozen lookup table the handlers + the §4.10 fan-out test read. Keys are
// upstream topic strings (`mN.<entity>.<event>`); values carry the LIVE/DENY-STUB status + the ordered list
// of M23 effects the topic triggers. Cross-module communication here is outbox-ONLY: M23 never imports
// M5/M6/M8/M18/M22/M40 internals (the dependency-cruiser blocks it); the topic STRING + the structurally-
// minimal payload shape is the entire contract — this file adds NO new manifest `dependsOn` edge.
//
// LIVE vs DENY-STUB (task posture). The M5/M6/M8/M18/M40 upstream modules are LOCKED — their topics are LIVE
// consumers today. M25 (remittance) and M26 (cap) have NOT landed; their topics are declared here as
// forward-seam DENY-STUBS (the handler fail-closes when run) so the §4.10 contract is complete but no live
// binding fires until those modules emit. `registerM23Consumers` binds only the LIVE topics (wired
// conservatively — the M27 consumers posture).
//
// EVENT-NAME PROVENANCE. `m6.election.signed` / `m6.revocation.created` / `m6.transfer.created` /
// `m6.discharge.created` / `m6.cti.signed` / `m6.f2f.attested` / `m6.loc.changed` / `m5.patient.deceased` /
// `m8.encounter.signed` / `m8.encounter.cosigned` / `m18.evv.late_check_resolved` / `m22.document.rendered`
// are confirmed against the live emitting modules (grep of apps/backend/src/modules/06|05|08|18|22). The M40
// canonical-update topic and the M25/M26 topics were the spec §4.4 / §8 / §10 documented names, carried here
// as placeholders with the instruction to "rebind to the canonical M40 event string when M40's
// events-by-m40.ts lands". BOTH HAVE LANDED, and nothing came back to rebind them (F-095): `m40-mdm`
// catalogues `m40.canonical.updated` and M26 catalogues `m26.cap.projection_updated`, while this file went on
// naming `mdm.canonical_updated` and `m26.cap.projection_updated.v1` — names no module has ever emitted, so
// the freeze-new-claims and cap-projection effects behind them could not fire. A placeholder that names a
// module's OWN spelling of an event is indistinguishable from a real subscription at a glance, which is why
// it survived; rule 6 of `check-outbox-bindings.ts` is what asks.

/** The validation_run trigger the §8 `revalidate.consumer` worker stamps for a re-validate fan-out (D1). */
export const RE_VALIDATION_TRIGGER = "re_validation_after_correction" as const;

/** The §3.3 `m23_notr_trigger_kind` a NOTR draft is seeded with (mirrors the DB enum; local to stay pure). */
export type NotrTriggerKind = "revocation" | "transfer_out" | "discharge";

/** Whether a subscribed topic is a LIVE consumer (upstream module locked) or a forward-seam DENY-STUB. */
export type M23SubscriptionStatus = "live" | "deny_stub";

/**
 * One M23 effect a delivered upstream event projects to (§4.4 / §4.10). Discriminated by `kind` so a new
 * effect is an additive case; every variant carries a human `note` (the §4.10 subscriber-table cell) for the
 * fan-out test + the catalog's reporting surface.
 */
export type M23SubscriptionEffect =
  /** Create a `noe_record` DRAFT from `m6.election.signed` (task 47); the bound noe-assembly port emits `m23.noe.draft_created`. */
  | { readonly kind: "create_noe_draft"; readonly note: string }
  /** Create a `notr_record` DRAFT from an M6 revocation / transfer-out / discharge (task 50); emits `m23.notr.draft_created`. */
  | { readonly kind: "create_notr_draft"; readonly trigger: NotrTriggerKind; readonly note: string }
  /** Enqueue a re-validate of every affected claim in VALIDATING/READY (tasks 53/54; trigger `re_validation_after_correction`). */
  | { readonly kind: "revalidate"; readonly note: string }
  /** Freeze new-claim creation for the affected patient (task 53; `m5.patient.deceased` / M40 canonical change). */
  | { readonly kind: "freeze_new_claims"; readonly note: string }
  /** Record the M22-returned `document_id` as the back-ref on `noe_record` / `notr_record` / `claim` (task 57). */
  | { readonly kind: "record_document_back_reference"; readonly note: string }
  /** Transition a claim to PAID / PARTIAL_PAID / DENIED from an M25 remittance (task 55; DENY-STUB today). */
  | { readonly kind: "claim_remittance_transition"; readonly note: string }
  /** Record the occurrence + alert past the §11.A/D13 30-day/50-threshold (F-164, #248). */
  | { readonly kind: "taxonomy_occurrence_alert"; readonly note: string };

/** The §4.4 / §8 documented M40 canonical-update topic (see EVENT-NAME PROVENANCE above). */
export const M40_CANONICAL_UPDATED_TOPIC = "m40.canonical.updated" as const;
/** The §4.4 / §8 documented M26 cap-projection-change topic (DENY-STUB until M26 lands). */
export const M26_CAP_PROJECTION_TOPIC = "m26.cap.projection_updated" as const;

/** One topic's subscription record: its LIVE/DENY-STUB status + the ordered M23 effects it triggers. */
export interface M23TopicSubscription {
  readonly status: M23SubscriptionStatus;
  readonly effects: readonly M23SubscriptionEffect[];
}

/**
 * The §4.4 / §4.10 catalog: upstream outbox topic → its LIVE/DENY-STUB status + the ordered M23 effects it
 * triggers. Frozen so no consumer can mutate it. The handlers in `./handlers.ts` read this map; the boot
 * dispatcher forward-declares one binding per LIVE key (the `M23_UPSTREAM_SUBSCRIPTIONS` list below).
 */
export const M23_OUTBOX_SUBSCRIPTIONS: Readonly<Record<string, M23TopicSubscription>> =
  Object.freeze({
    // ── M6 election → NOE draft (task 47) ───────────────────────────────────────────────────────────────
    // F-106 — the trigger is `period_started`, NOT `election.signed`. `noe_record.election_effective_date`
    // and `window_target_at` are both NOT NULL, and the election's effective date exists in exactly one
    // place: `election_period.effective_at`, written by the `setActive` transition at admission
    // ACTIVATION. `election_statement` carries only `signed_at`. At signing time the anchor is NULL, so a
    // draft created there could not be dated — and the CMS deadline IS the date. `period_started` is
    // emitted from the same transaction that writes the column.
    "m6.election.period_started": {
      status: "live",
      effects: [
        {
          kind: "create_noe_draft",
          note: "An election period activated in M6 — M23 creates the `noe_record` DRAFT for a FIRST period (an NOE is filed once per election, not per benefit period) and computes the 5-day CMS filing-window target (task 47, 42 CFR 418.24(b)); the bound noe-assembly port emits `m23.noe.draft_created`.",
        },
      ],
    },

    // ── M6 revocation / transfer-out / discharge → NOTR draft (task 50) ─────────────────────────────────
    "m6.revocation.created": {
      status: "live",
      effects: [
        {
          kind: "create_notr_draft",
          trigger: "revocation",
          note: "A benefit revocation was recorded in M6 — M23 creates a `notr_record` DRAFT (trigger `revocation`) and computes the filing-window target (task 50); emits `m23.notr.draft_created`.",
        },
      ],
    },
    "m6.transfer.created": {
      status: "live",
      effects: [
        {
          kind: "create_notr_draft",
          trigger: "transfer_out",
          note: "A transfer was recorded in M6 — ONLY a transfer-OUT (direction='out') seeds a `notr_record` DRAFT (trigger `transfer_out`); a transfer-IN is a deliberate no-op (task 50).",
        },
      ],
    },
    "m6.discharge.created": {
      status: "live",
      effects: [
        {
          kind: "create_notr_draft",
          trigger: "discharge",
          note: "A discharge was recorded in M6 — M23 creates a `notr_record` DRAFT (trigger `discharge`) and computes the filing-window target (task 50); emits `m23.notr.draft_created`.",
        },
      ],
    },

    // ── M5 patient deceased → freeze new claims + re-validate in-flight (task 53) ────────────────────────
    "m5.patient.deceased": {
      status: "live",
      effects: [
        {
          kind: "freeze_new_claims",
          note: "The patient was marked deceased in M5 — M23 freezes new-claim creation for the decedent (task 53); only the discharge/bereavement claim path proceeds.",
        },
        {
          kind: "revalidate",
          note: "Re-validate every in-flight (VALIDATING/READY) claim for the decedent so a date-of-death-dependent rule re-runs (task 53/54).",
        },
      ],
    },

    // ── M6 cert / F2F / LOC → re-validate (task 53) ─────────────────────────────────────────────────────
    "m6.cti.signed": {
      status: "live",
      effects: [
        {
          kind: "revalidate",
          note: "A CTI was signed in M6 (CMS 418.22) — re-validate every affected claim so the `cti_signed_for_period` rule re-runs (task 53/54).",
        },
      ],
    },
    "m6.f2f.attested": {
      status: "live",
      effects: [
        {
          kind: "revalidate",
          note: "An F2F was attested in M6 — re-validate every affected claim so the `f2f_attested_for_recert` rule re-runs (task 53/54; the §11 Whitfield walkthrough).",
        },
      ],
    },
    "m6.loc.changed": {
      status: "live",
      effects: [
        {
          kind: "revalidate",
          note: "A level-of-care change was recorded in M6 — re-validate the affected claim's date range so HIPPS is recomputed (task 53/54).",
        },
      ],
    },
    // F-153 (#248) — an election period auto-ending shifts the claim-period anchor the same way
    // `.period_started` does; the spec's own text names both beside each other.
    "m6.election.period_ended": {
      status: "live",
      effects: [
        {
          kind: "revalidate",
          note: "An election period auto-ended in M6 — re-validate affected claims so the period-anchoring rules re-run against the new benefit-period boundary (task 53/54).",
        },
      ],
    },

    // A place of death / receiving care setting recorded after the fact (M6 discharge-details routes) is
    // exactly the fact the `bereavement_discharge_legitimacy` rule was blocking on — re-validate so the claim
    // clears without a manual re-run.
    "m6.discharge.details_recorded": {
      status: "live",
      effects: [
        {
          kind: "revalidate",
          note: "A claim-relevant discharge detail (place of death / receiving care setting) was recorded in M6 — re-validate the admission's open claims so the patient discharge status is re-derived.",
        },
      ],
    },

    // ── M8 encounter signed / cosigned → re-validate (task 53) ──────────────────────────────────────────
    "m8.encounter.signed": {
      status: "live",
      effects: [
        {
          kind: "revalidate",
          note: "An encounter was signed in M8 — the daily claim-eligibility recompute re-validates affected claims so the newly-billable visit can be brought onto a line (task 53/54).",
        },
      ],
    },
    "m8.encounter.cosigned": {
      status: "live",
      effects: [
        {
          kind: "revalidate",
          note: "An LPN/CHHA encounter was cosigned in M8 (M8 D3) — the visit is now billable; re-validate affected claims so it leaves the `awaiting_cosignature` hold (task 53/54).",
        },
      ],
    },

    // ── M18 EVV late-check resolved → re-validate (task 53) ─────────────────────────────────────────────
    "m18.evv.late_check_resolved": {
      status: "live",
      effects: [
        {
          kind: "revalidate",
          note: "An EVV unresolved-missing bracket was resolved in M18 — re-validate affected claims so the hard `unresolved_missing` EVV rule clears (task 53/54).",
        },
      ],
    },

    // ── M40 master-data canonical change → re-validate (task 53) ────────────────────────────────────────
    [M40_CANONICAL_UPDATED_TOPIC]: {
      status: "live",
      effects: [
        {
          kind: "revalidate",
          note: "An M40 canonical entity (NPI / physician credential) changed — re-validate affected claims so the `physician credentials` rule re-runs against the new canonical fact (task 53/54).",
        },
      ],
    },

    // ── M25 unmapped-taxonomy occurrence → §11.A/D13 threshold alert (F-164, #248) ──────────────────────
    // Bound via a dedicated `outbox-consumers/m25-taxonomy-unmapped-code-observed.ts` consumer, NOT
    // `registerM23Consumers`'s effect dispatch (the `m6.cti.signed`/`m18.evv.late_check_resolved`
    // "revalidate" entries above are the same shape — this map documents every subscription regardless of
    // which mechanism implements it).
    "m25.taxonomy.unmapped_code_observed": {
      status: "live",
      effects: [
        {
          kind: "taxonomy_occurrence_alert",
          note: "A CARC/RARC code M38's catalog doesn't map was observed on a denial — record the occurrence and, once the org's rolling 30-day count for that CARC exceeds 50, dispatch an unmapped_taxonomy_alert via the M36 AlertEmitter seam.",
        },
      ],
    },

    // ── M22 document render handshake (task 57) ─────────────────────────────────────────────────────────
    "m22.document.rendered": {
      status: "live",
      effects: [
        {
          kind: "record_document_back_reference",
          note: "M22 rendered + stored a NOE/NOTR receipt or claim-ack letter and returned its document id — M23 records the back-ref `document_id` on `noe_record` / `notr_record` / `claim` (task 57).",
        },
      ],
    },

    // ── M25 remittance → claim PAID/PARTIAL_PAID/DENIED/reversal (task 55 — LIVE since GAP-037) ──────────
    // These four names are M25's ACTUAL emitted set. The fourth used to read `m25.remittance.claim_adjusted`
    // — a name M25 has never published (its reversal event is `claim_recouped`), so binding the old key
    // would have subscribed to nothing while every real reversal went unconsumed.
    "m25.remittance.claim_paid": {
      status: "live",
      effects: [
        {
          kind: "claim_remittance_transition",
          note: "M25 posted an 835 full-payment — claim ACK_ACCEPTED → PAID, emit `m23.claim.paid` + `m23.claim.adjudicated` (task 55).",
        },
      ],
    },
    "m25.remittance.claim_partial_paid": {
      status: "live",
      effects: [
        {
          kind: "claim_remittance_transition",
          note: "M25 posted an 835 partial-payment — claim ACK_ACCEPTED → PARTIAL_PAID, emit `m23.claim.adjudicated` with outcome `partial_paid` (task 55).",
        },
      ],
    },
    "m25.remittance.claim_denied": {
      status: "live",
      effects: [
        {
          kind: "claim_remittance_transition",
          note: "M25 posted a denial 835 — claim ACK_ACCEPTED → DENIED, emit `m23.claim.denied` + `m23.claim.adjudicated` (task 55).",
        },
      ],
    },
    "m25.remittance.claim_recouped": {
      status: "live",
      effects: [
        {
          kind: "claim_remittance_transition",
          note: "M25 posted a CLP02=22 reversal (42 CFR §424.526) — the payment is taken back, so PAID/PARTIAL_PAID → ACK_ACCEPTED awaiting re-adjudication. M23 emits nothing: M26 reverses its cap accrual off M25's own event.",
        },
      ],
    },

    // ── M26 cap projection change → re-validate (task 56 — DENY-STUB until M26 lands) ────────────────────
    [M26_CAP_PROJECTION_TOPIC]: {
      status: "deny_stub",
      effects: [
        {
          kind: "revalidate",
          note: "M26 recomputed an aggregate cap projection — re-validate claims in VALIDATING whose `aggregate cap projection not exceeded` rule depends on it (task 56). DENY-STUB until M26 lands.",
        },
      ],
    },
  });

/** Every upstream topic M23 subscribes to (the §4.4 inbound set, LIVE + DENY-STUB). */
export const M23_OUTBOX_SUBSCRIPTION_TOPICS: readonly string[] = Object.freeze(
  Object.keys(M23_OUTBOX_SUBSCRIPTIONS),
);

/** Only the LIVE topics — the boot dispatcher binds these today (M5/M6/M8/M18/M40 are locked). */
export const M23_LIVE_SUBSCRIPTION_TOPICS: readonly string[] = Object.freeze(
  M23_OUTBOX_SUBSCRIPTION_TOPICS.filter((t) => M23_OUTBOX_SUBSCRIPTIONS[t]?.status === "live"),
);

/** Only the DENY-STUB topics — declared for §4.10 completeness; bound when M25/M26 land. */
export const M23_DENY_STUB_SUBSCRIPTION_TOPICS: readonly string[] = Object.freeze(
  M23_OUTBOX_SUBSCRIPTION_TOPICS.filter((t) => M23_OUTBOX_SUBSCRIPTIONS[t]?.status === "deny_stub"),
);

/**
 * The ordered M23 effects a delivered upstream topic projects to (the handlers' fan-out lookup). Returns an
 * EMPTY array for an unknown topic — a deliberate no-op, never an error (M23 tolerates upstream emitting
 * events it does not map, exactly as M27's `effectsForTopic` does).
 */
export function effectsForTopic(topic: string): readonly M23SubscriptionEffect[] {
  return M23_OUTBOX_SUBSCRIPTIONS[topic]?.effects ?? [];
}

/** The LIVE/DENY-STUB status of a subscribed topic (`undefined` for an unsubscribed topic). */
export function statusForTopic(topic: string): M23SubscriptionStatus | undefined {
  return M23_OUTBOX_SUBSCRIPTIONS[topic]?.status;
}

// ── forward-declared subscription bindings (the boot dispatcher wires these; RULE 3(d) defers the rail) ──

/** The shared consumer name every M23 upstream binding registers under. Consumer dedup is keyed
 *  `(eventId, consumerName)` per the M1 outbox-consumer pattern (the M22/M27/M30/M33/M34 precedent). */
export const M23_UPSTREAM_CONSUMER_NAME = "m23.upstream-consumer" as const;

/** One forward-declared `{ eventName, consumerName, status }` binding (the M27 `M27UpstreamSubscription`
 *  shape) the boot dispatcher wires once the live inbound transactional-outbox dispatcher accessor lands. */
export interface M23UpstreamSubscription {
  readonly eventName: string;
  readonly consumerName: typeof M23_UPSTREAM_CONSUMER_NAME;
  readonly status: M23SubscriptionStatus;
}

/** Every subscribed §4.4 topic, forward-declared as a consumer binding (LIVE + DENY-STUB, status-tagged). */
export const M23_UPSTREAM_SUBSCRIPTIONS: readonly M23UpstreamSubscription[] =
  M23_OUTBOX_SUBSCRIPTION_TOPICS.map((eventName) => ({
    eventName,
    consumerName: M23_UPSTREAM_CONSUMER_NAME,
    status: M23_OUTBOX_SUBSCRIPTIONS[eventName]?.status ?? "deny_stub",
  }));

/** DEFERRED until the live inbound transactional-outbox dispatcher exists in bootstrap (RULE 3(d), the M27
 *  `M27_UPSTREAM_SUBSCRIPTIONS_DEFERRED` precedent). The consumers ship PURE + this subscription map; no
 *  running subscriber boots here. */
export const M23_UPSTREAM_SUBSCRIPTIONS_DEFERRED = true as const;

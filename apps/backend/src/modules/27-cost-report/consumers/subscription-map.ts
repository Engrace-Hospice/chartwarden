// apps/backend/src/modules/27-cost-report/consumers — the §4.10 / D3 UPSTREAM outbox-subscription map
// (the M27 inbound catalog). Mirrors the M30 `@chartwarden/quality` consumers/subscription-map.ts precedent.
//
// M27 is not only an event PRODUCER (events-by-m27.ts) — it also SUBSCRIBES to a small set of upstream
// topics and projects each into an M27-local effect: (1) the M22 render handshake returns a document id
// which M27 records as the ECR / PI / supporting-doc back-reference on `ecr_submission`; (2) an M25 claim
// DENIAL surfaces a MAC rejection code which M27 matches against the rule library, auto-suggesting a draft
// rule when uncovered (D20); (3) an M40 ProviderEntity OFFBOARD closes the provider's still-open cost
// reports (§2.2 → terminal `closed`). This module is the SINGLE SOURCE OF TRUTH for that topic→effect
// fan-out; the pure handlers in `./handlers.ts` read THIS map, and the boot dispatcher (a later platform
// phase, RULE 3(d)) forward-declares one consumer binding per subscribed topic.
//
// F-108 — `m22.document.rendered` is now LIVE, bound in `../outbox-consumers/m22-document-backref.ts`
// from the composition root. The other two are not, and for different reasons: `m25.denial.opened` has a
// written handler and no binding, and the M40 offboard topic below is a name no catalog carries under any
// spelling (M40 publishes `canonical.updated` / `canonical.deactivated` and no provider-entity offboard),
// so it is registered `no-such-event` rather than deferred. `M27_UPSTREAM_SUBSCRIPTIONS_DEFERRED` stays
// true because it describes THIS surface: `registerM27Consumers` still boots no running subscriber.
//
// PURE DATA. No I/O, no DB — a frozen lookup table the handlers + the §4.10 fan-out test read. Keys are
// upstream topic strings (`mN.<entity>.<event>`); values are the ordered list of M27 effects that topic
// triggers. Cross-module communication here is outbox-ONLY: M27 never imports M22/M25/M40 internals (the
// dependency-cruiser blocks it); the topic STRING + the structurally-minimal payload shape is the entire
// contract — this file adds NO new manifest `dependsOn` edge.
//
// EVENT-NAME PROVENANCE. `m22.document.rendered` and `m25.denial.opened` are confirmed against the live
// emitting modules (apps/backend/src/modules/22-documents + the M25 event taxonomy; the spec §4.10 / §82
// names them too). The M40 OFFBOARD topic is the spec §2.2 / D3 documented name `provider_entity_offboarded`
// (the consumer file the spec §3.1 names is `m40-provider-entity-offboarded.ts`); M40's events-by file is
// not yet landed, and the closest real emitted M40 event today is `m40.nppes.provider_deactivated.applied`.
// Per the task's "use the documented §4.10 names and note it" rule, the topic key below is the namespaced
// spec name; rebind it to the canonical M40 event string when M40's events-by-m40.ts lands.

/** The artifact kinds M27 publishes for M22 render+store (the `m27.artifact.render_requested` payload). */
export type M27ArtifactKind = "ecr" | "pi" | "supporting_doc";

/**
 * One M27 effect a delivered upstream event projects to (§4.10). Discriminated by `kind` so a new effect
 * is an additive case; every variant carries a human `note` (the §4.10 subscriber-table cell) for the
 * fan-out test + the catalog's reporting surface.
 */
export type M27SubscriptionEffect =
  /** Record the M22-returned `document_id` as the ECR / PI / supporting-doc back-ref on `ecr_submission`. */
  | { readonly kind: "artifact_back_reference"; readonly note: string }
  /** Match a MAC rejection code against the rule library; auto-suggest a draft rule when uncovered (D20). */
  | { readonly kind: "rule_suggestion"; readonly note: string }
  /** Close the ProviderEntity's still-open cost reports on offboard (§2.2 → terminal `closed`). */
  | { readonly kind: "close_cost_reports"; readonly note: string }
  /** Record (or reconcile) the fiscal-year-resolved 4th cost-basis precedence tier on `vendor_invoice_line`. */
  | { readonly kind: "vendor_invoice_accrual"; readonly note: string };

/** The spec §2.2 / D3 documented M40 offboard topic (see EVENT-NAME PROVENANCE above). */
export const M40_PROVIDER_ENTITY_OFFBOARDED_TOPIC = "m40.provider_entity.offboarded" as const;

/**
 * The §4.10 catalog: upstream outbox topic → the ordered M27 effects it triggers. Frozen so no consumer
 * can mutate it. The handlers in `./handlers.ts` read this map; the boot dispatcher forward-declares one
 * binding per key (the `M27_UPSTREAM_SUBSCRIPTIONS` list below).
 */
export const M27_OUTBOX_SUBSCRIPTIONS: Readonly<Record<string, readonly M27SubscriptionEffect[]>> =
  Object.freeze({
    // ── M22 document render handshake (§4.4 / §4.11) ──────────────────────────────────────────────────
    "m22.document.rendered": [
      {
        kind: "artifact_back_reference",
        note: "M22 stored the ECR / PI / supporting-doc bytes and returned its document id — M27 records the back-reference on `ecr_submission` (ecr_file_document_id / pi_file_document_id / supporting_documents_document_ids) and emits `m27.artifact.stored_back_reference`.",
      },
    ],

    // ── M21 supply-request vendor invoice — the 4th cost-basis precedence tier (F-207, #248) ─────────
    "m21.supply_request.invoice_accrued": [
      {
        kind: "vendor_invoice_accrual",
        note: "A vendor invoice was accrued against a supply request — resolved to the fiscal-year cost report by (providerEntityId, factDate) and recorded as an idempotent `vendor_invoice_line` row (migration 0276), the residual 4th tier below M13 administration / M12 ordered / manual entry.",
      },
    ],
    "m21.supply_request.invoice_reconciled": [
      {
        kind: "vendor_invoice_accrual",
        note: "The accrued vendor invoice was reconciled — the matching `vendor_invoice_line` row (status = 'accrued') is updated in place; a redelivery after reconciliation already landed is a no-op.",
      },
    ],

    // ── M25 remittance — claim denial (§82 auto-rule-suggestion, D20) ─────────────────────────────────
    "m25.denial.opened": [
      {
        kind: "rule_suggestion",
        note: "A MAC denial's rejection code is matched against the rule library; an uncovered code auto-creates a `draft_suggestion` rule (anonymized) and emits `m27.validation.rule_suggestion_created`.",
      },
    ],

    // ── M40 master data — ProviderEntity offboard (§2.2 → terminal `closed`) ──────────────────────────
    [M40_PROVIDER_ENTITY_OFFBOARDED_TOPIC]: [
      {
        kind: "close_cost_reports",
        note: "The ProviderEntity was offboarded — every still-open (offboard-eligible) cost report for it transitions to terminal `closed`, each emitting `m27.cost_report.closed`; submission history is retained.",
      },
    ],
  });

/** Every upstream topic M27 subscribes to (the §4.10 inbound set). */
export const M27_OUTBOX_SUBSCRIPTION_TOPICS: readonly string[] = Object.freeze(
  Object.keys(M27_OUTBOX_SUBSCRIPTIONS),
);

/**
 * The ordered M27 effects a delivered upstream topic projects to (the handlers' fan-out lookup). Returns
 * an EMPTY array for an unknown topic — a deliberate no-op, never an error (M27 tolerates upstream
 * emitting events it does not map, exactly as M30's `effectsForTopic` does).
 */
export function effectsForTopic(topic: string): readonly M27SubscriptionEffect[] {
  return M27_OUTBOX_SUBSCRIPTIONS[topic] ?? [];
}

// ── forward-declared subscription bindings (the boot dispatcher wires these; RULE 3(d) defers the rail) ──

/** The shared consumer name every M27 upstream binding registers under. Consumer dedup is keyed
 *  `(eventId, consumerName)` per the M1 outbox-consumer pattern (the M22/M30/M33/M34 precedent). */
export const M27_UPSTREAM_CONSUMER_NAME = "m27.upstream-consumer" as const;

/** One forward-declared `{ eventName, consumerName }` binding (the M30 `M30UpstreamSubscription` shape) the
 *  boot dispatcher wires once the live inbound transactional-outbox dispatcher accessor lands (RULE 3(d)). */
export interface M27UpstreamSubscription {
  readonly eventName: string;
  readonly consumerName: typeof M27_UPSTREAM_CONSUMER_NAME;
}

/** Every subscribed §4.10 topic, forward-declared as a consumer binding. */
export const M27_UPSTREAM_SUBSCRIPTIONS: readonly M27UpstreamSubscription[] =
  M27_OUTBOX_SUBSCRIPTION_TOPICS.map((eventName) => ({
    eventName,
    consumerName: M27_UPSTREAM_CONSUMER_NAME,
  }));

/** DEFERRED until the live inbound transactional-outbox dispatcher exists in bootstrap (RULE 3(d), the M30
 *  `M30_UPSTREAM_SUBSCRIPTIONS_DEFERRED` precedent). The consumers ship PURE + this subscription map; no
 *  running subscriber boots here. */
export const M27_UPSTREAM_SUBSCRIPTIONS_DEFERRED = true as const;

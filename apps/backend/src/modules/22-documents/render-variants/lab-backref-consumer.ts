// apps/backend/src/modules/22-documents/render-variants/lab-backref-consumer.ts — M22-T09 the §7.15/§7.16
// lab-results back-ref consumer. DENY-STUB / FORWARD-DECLARED (M29 lands in Wave H; M6-T11 / T06 precedent).
//
// The §7.15 W-M22-22 lab-results render is triggered by M11's `m11.order.results_received` (a render request,
// drained by the T06 `decideDocumentRequest` path) — but resolving the OBSERVATION VALUES it renders needs
// M29's `LabObservationReader` seam, and M29 is NOT yet built (Wave H). So this file ships the PURE decision
// core that, GIVEN the resolved observation facts (the values + their per-row SUD-class flags + the M39
// consent fact), decides the lab-results render variant + the §7.16 SUD-redaction — and a deny-stub fact
// resolver for the M29 seam that fail-CLOSES (no observation reader yet ⇒ refuse-to-render, never render a
// blank/unredacted PDF). The live binding (subscribing the dispatcher + resolving the M29 reader) is
// forward-declared/deferred in ./lab-backref-bindings.ts.
//
// Why no edge: M22 `dependsOn` is `[1, 5]`. M22 reads M11/M29 SOLELY through the foundation outbox event
// STRING + the opaque M1 seam registry — never a `dependsOn` edge or a producer-package import. The consumed
// event name is a STRING literal and the consumed payload is a locally-declared structural minimum. This
// directory is NOT scanned by arch:gaps' event-catalog / seam-registry gates, so consuming `m11.*` here adds
// no M22-produced event and no edge.
import type { DocumentRetentionClass } from "@wardenx/types";
import {
  planLabResultsRender,
  type LabResultsRenderPayload,
  type RenderVariantResult,
} from "./render-variants";

/** The §7.15 lab-results render-request event M22 consumes (STRING literal — no producer import). M11 emits
 * it once an observation set is signed/received; M22 renders the `lab_results_pdf` + back-refs the order. */
export const M22_LAB_RESULTS_EVENT = "m11.order.results_received" as const;

/** The M22 consumer name that drains the lab-results render queue (the `(eventId, consumerName)` dedup key). */
export const M22_LAB_RESULTS_CONSUMER = "m22.lab-results-pdf-renderer" as const;

/** The `m11.order.results_received` payload, as M11 hands it on the outbox (structural minimum — M11 owns the
 * canonical order; M29 owns the observation values, reached via its `LabObservationReader` seam). M22 reads
 * the routing keys; the observation VALUES are resolved separately (the M29 reader is the deny-stub below). */
export interface LabResultsRequestPayload {
  readonly orderId: string;
  readonly organizationId: string;
  readonly observationId: string;
  readonly patientId: string;
  readonly orderingPhysicianMdmId: string;
  readonly signedAt: string;
  readonly attachmentKind: "full" | "summary";
}

/** The facts the live consumer resolves before deciding a lab render — surfaced as DATA so the decider stays
 * pure. The live consumer resolves these from the outbox-dedup registry (idempotency), the M29
 * `LabObservationReader` seam (`observationsResolved` + the per-row values/SUD flags carried on `renderPayload`),
 * and the M39 `ConsentEvaluator` seam (`sudConsentPresent`). In Phase 1 the M29 resolver is the deny-stub. */
export interface LabBackrefFacts {
  /** A prior `m22.document.rendered` already back-refs this `(event, orderId)` — re-delivery skip (D14). */
  readonly alreadyRendered: boolean;
  /** The M29 `LabObservationReader` resolved the observation values (false ⇒ deny-stub / reader unavailable). */
  readonly observationsResolved: boolean;
  /** The resolved lab-results render payload (the observation rows + per-row SUD flags). Null when unresolved. */
  readonly renderPayload: LabResultsRenderPayload | null;
  /** The M39 `ConsentEvaluator` returned an active `42_cfr_part_2_release` consent (drives §7.16 redaction). */
  readonly sudConsentPresent: boolean;
}

/** The single effect the lab-backref decider resolves for one delivered `m11.order.results_received`. */
export type LabBackrefAction =
  /** Re-delivery of an already-rendered order — skip, no duplicate document (D14 idempotency). */
  | { readonly kind: "idempotent_skip" }
  /** The M29 observation reader is unavailable (Wave-H deny-stub) — defer; NEVER render a blank/unredacted
   * PDF. The worker retries-then-dead-letters once M29 lands. */
  | { readonly kind: "observations_unresolved"; readonly observationId: string }
  /** The happy path — render the lab-results variant (with §7.16 SUD redaction baked in by `consentPresent`). */
  | {
      readonly kind: "render";
      readonly variant: RenderVariantResult;
      readonly retentionClass: DocumentRetentionClass;
      readonly orderId: string;
    };

/**
 * Decide the single effect for one delivered `m11.order.results_received` (§7.15/§7.16, pure). Gate order:
 * idempotency → M29-observations-resolved (deny-stub fail-closed) → render the lab variant with §7.16 SUD
 * redaction applied per-row via the injected `sudConsentPresent`. When ANY row redacts, the variant forces
 * `compliance_42cfr_part2` retention (D23). The live consumer executes the returned `render` through the T04
 * `DocumentRenderer` seam, then emits `m22.document.rendered` so M11's existing back-ref consumer applies
 * `order_record.document_id`.
 */
export function decideLabBackref(
  payload: LabResultsRequestPayload,
  facts: LabBackrefFacts,
): LabBackrefAction {
  // 1. Idempotency (D14): a re-delivery never produces a second lab-results document for the same order.
  if (facts.alreadyRendered) return { kind: "idempotent_skip" };

  // 2. M29 deny-stub (Wave H): no observation reader ⇒ refuse to render (never a blank/unredacted PDF).
  if (!facts.observationsResolved || facts.renderPayload === null) {
    return { kind: "observations_unresolved", observationId: payload.observationId };
  }

  // 3. Happy path — plan the §7.15/§7.16 lab-results render variant (SUD redaction baked in by the consent fact).
  const variant = planLabResultsRender({
    payload: facts.renderPayload,
    consentPresent: facts.sudConsentPresent,
  });
  const retentionClass: DocumentRetentionClass =
    variant.retentionClassOverride ?? "clinical_record";
  return { kind: "render", variant, retentionClass, orderId: payload.orderId };
}

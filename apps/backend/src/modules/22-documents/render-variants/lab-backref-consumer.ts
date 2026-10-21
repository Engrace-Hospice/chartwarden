// apps/backend/src/modules/22-documents/render-variants/lab-backref-consumer.ts — M22-T09 the §7.15/§7.16
// lab-results back-ref consumer. LIVE since F-171 (#248) — M29's `LabObservationReader` seam is registered
// at boot (`registerM29PublishedSeams`) and the M22-side deny-stub is gone.
//
// The §7.15 W-M22-22 lab-results render is triggered by M11's `m11.order.results_received`. It is
// DELIBERATELY NOT one of the generic `outbox-consumers/render-consumer.ts` §4.11 `REQUEST_SHAPES` entries:
// that pipeline's own idempotency is genesis-only (`renderedDocumentForAggregate`, keyed on
// `(aggregateType, aggregateId)`), and `lab_results_pdf`'s published `aggregateType` is `order_record` —
// the SAME (aggregateType, aggregateId) pair `m11.order.document_requested`'s order-FORM render already
// occupies at sign time. Genesis-only idempotency would read that pair as "already rendered" the instant an
// order is signed and silently `idempotent_skip` the lab result FOREVER. `order_record.document_id` is a
// single column meant to track EITHER artifact (M11's `m22-document-rendered.ts` back-ref consumer already
// treats `order_record` as one aggregate bucket for both — see its own comment), so the correct model is a
// NEW VERSION of the order's document trail, not a second `document` row: this file uses the F-168
// per-delivered-event dedup (`documentVersionForSourceEvent`, keyed on the specific outbox event id) instead
// — the same `appends`-shaped idempotency `m8.encounter.addendum_signed`/`m14.minutes.amended` use, applied
// here at the dedicated-pipeline level rather than as a `REQUEST_SHAPES` flag.
//
// This file ships the PURE decision core: GIVEN the resolved observation facts (the values + their per-row
// SUD-class flags, from M29's real `LabObservationSeamValue.isSudClass`, F-171 — never fabricated; it is the
// honest per-value projection of the parent `lab_observation.sud_redacted_at_ingest` ingest-time flag) and
// the M39 consent fact, it decides the lab-results render variant + the §7.16 SUD-redaction. The live
// resolvers (the M29 seam call, the idempotency read, the M39 consent gate, the actual render + emit) are in
// ./lab-backref-bindings.ts.
//
// Why no edge: M22 `dependsOn` is `[1, 5]`. M22 reads M11/M29 SOLELY through the foundation outbox event
// STRING + the opaque M1 seam registry — never a `dependsOn` edge or a producer-package import. The consumed
// event name is a STRING literal and the consumed payload is a locally-declared structural minimum. This
// directory is NOT scanned by arch:gaps' event-catalog / seam-registry gates, so consuming `m11.*` here adds
// no M22-produced event and no edge.
import type { DocumentRetentionClass } from "@chartwarden/types";
import {
  type LabResultValue,
  type LabResultsRenderPayload,
  type RenderVariantResult,
  planLabResultsRender,
} from "./render-variants";

/** The §7.15 lab-results render-request event M22 consumes (STRING literal — no producer import). M11 emits
 * it once an observation set is signed/received; M22 renders the `lab_results_pdf` + back-refs the order. */
export const M22_LAB_RESULTS_EVENT = "m11.order.results_received" as const;

/** The M22 consumer name that drains the lab-results render queue (the `(eventId, consumerName)` dedup key). */
export const M22_LAB_RESULTS_CONSUMER = "m22.lab-results-pdf-renderer" as const;

/** The `m11.order.results_received` payload, as M11 actually hands it on the outbox (`events-by-m11.ts`'s
 * own `payloadSchema` — checked against the real catalog, not assumed: it carries NO `patientId` at all,
 * which is why the M29 lookup below is `getByObservationId`, not `getById`, and `attachmentKind` is
 * `"full" | "partial"`, not the `"summary"` this file previously declared). M22 reads the routing keys; the
 * observation VALUES and the PATIENT are resolved separately via the M29 `LabObservationReader` seam. */
export interface LabResultsRequestPayload {
  readonly orderId: string;
  readonly organizationId: string;
  readonly observationId: string;
  readonly orderingPhysicianMdmId: string;
  readonly signedAt: string;
  readonly attachmentKind: "full" | "partial";
}

/** The facts the live consumer resolves before deciding a lab render — surfaced as DATA so the decider stays
 * pure. The live consumer resolves these from the `document_version.source_event_id` dedup (idempotency,
 * F-168), the M29 `LabObservationReader.getByObservationId` seam (`observationsResolved` + the per-row
 * values/SUD flags carried on `renderPayload`), and the M39 `ConsentEvaluator` seam (`sudConsentPresent`). */
export interface LabBackrefFacts {
  /** A prior `document_version` already carries this DELIVERED outbox event's own id as its
   *  `source_event_id` — a genuine crash-retry redelivery of the SAME event, re-delivery skip (D14/F-168).
   *  Deliberately NOT aggregate-level (`renderedDocumentForAggregate`): `lab_results_pdf` shares its
   *  published `aggregateType` (`order_record`) with the order-FORM render, so an aggregate-level check
   *  would read "the order already has a document" and skip the lab result forever once the order form
   *  had ever rendered. Per-event dedup means a genuinely new observation always renders (a NEW version of
   *  the order's document trail), while a crash-retry of the SAME delivery is still a true no-op. */
  readonly alreadyRendered: boolean;
  /** The M29 `LabObservationReader` resolved the observation (false ⇒ no matching row — the observation has
   *  not landed yet, or belongs to another org/patient). */
  readonly observationsResolved: boolean;
  /** The resolved lab-results render payload (the observation rows + per-row SUD flags). Null when unresolved. */
  readonly renderPayload: LabResultsRenderPayload | null;
  /** The M39 `ConsentEvaluator` returned an active `42_cfr_part_2_release` consent (drives §7.16 redaction). */
  readonly sudConsentPresent: boolean;
}

/** The single effect the lab-backref decider resolves for one delivered `m11.order.results_received`. */
export type LabBackrefAction =
  /** Re-delivery of the SAME outbox event, already applied — skip, no duplicate version (D14/F-168). */
  | { readonly kind: "idempotent_skip" }
  /** The M29 observation reader found no matching row yet (a genuine ingest-ordering race, or the wrong
   *  org/patient) — defer; NEVER render a blank/unredacted PDF. The worker retries-then-dead-letters. */
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
 * idempotency (F-168 per-event dedup) → M29-observation-resolved (fail-closed — no row, no render) → render
 * the lab variant with §7.16 SUD redaction applied per-row via the injected `sudConsentPresent`. When ANY row
 * redacts, the variant forces `compliance_42cfr_part2` retention (D23). The live consumer executes the
 * returned `render` through the T04 `DocumentRenderer` seam (as a NEW VERSION of the order's `order_record`
 * document trail, never a fresh aggregate — see {@link LabBackrefFacts.alreadyRendered}), then emits
 * `m22.document.rendered` so M11's existing back-ref consumer applies `order_record.document_id`.
 */
export function decideLabBackref(
  payload: LabResultsRequestPayload,
  facts: LabBackrefFacts,
): LabBackrefAction {
  // 1. Idempotency (D14/F-168): a crash-retry redelivery of the SAME outbox event never produces a second
  // document_version — but a genuinely NEW observation for the same order always does (see the doc comment
  // on `alreadyRendered` for why this is per-event, not per-aggregate).
  if (facts.alreadyRendered) return { kind: "idempotent_skip" };

  // 2. No matching M29 observation row yet ⇒ refuse to render (never a blank/unredacted PDF); defer/retry.
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

// ── the M29 DTO → M22 render-payload mapping (pure) ────────────────────────────────────────────────────

/** The M22-local structural projection of one `LabObservationSeamValue` (M29's real per-value DTO shape,
 * `published.ts`) — declared locally rather than imported (M22 deps stay `[1, 5]`, no M29 producer import). */
export interface LabObservationSeamValuePort {
  readonly loincCode: string;
  readonly loincDisplayText: string;
  readonly numericValue: number | null;
  readonly stringValue: string | null;
  readonly units: string | null;
  readonly isSudClass: boolean;
}

/** The M22-local structural projection of `LabObservationSeamDTO` — only the fields the lab-results render
 * actually reads (M29 owns the canonical, richer DTO). */
export interface LabObservationSeamDtoPort {
  readonly id: string;
  readonly patientId: string;
  readonly values: readonly LabObservationSeamValuePort[];
}

/**
 * Map the resolved M29 observation DTO + the M11 request payload into M22's {@link LabResultsRenderPayload}
 * (pure, F-171). `orderId`/`signedAt` come from M11's own request payload (the real catalogued
 * `m11.order.results_received` schema, which carries them); `patientId` and every observation VALUE come
 * from the M29 DTO — the request payload carries no `patientId` at all (checked against `events-by-m11.ts`,
 * not assumed). `orderingPhysician` is honestly the M40 MDM id, not a resolved display name: M22 `dependsOn`
 * is `[1, 5]` and has no M40 seam to turn an id into a name, and inventing a placeholder name here would be
 * worse than an honest identifier the reader can resolve elsewhere.
 */
export function buildLabResultsRenderPayload(
  requestPayload: LabResultsRequestPayload,
  dto: LabObservationSeamDtoPort,
): LabResultsRenderPayload {
  const resultValues: LabResultValue[] = dto.values.map((v) => ({
    observationId: dto.id,
    loincCode: v.loincCode,
    label: v.loincDisplayText || v.loincCode,
    value: v.numericValue !== null ? String(v.numericValue) : v.stringValue,
    unit: v.units,
    isSudClass: v.isSudClass,
  }));
  return {
    orderId: requestPayload.orderId,
    patientId: dto.patientId,
    orderingPhysician: requestPayload.orderingPhysicianMdmId,
    signedAt: requestPayload.signedAt,
    resultValues,
  };
}

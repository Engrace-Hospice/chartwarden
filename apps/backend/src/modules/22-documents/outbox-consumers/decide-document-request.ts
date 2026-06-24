// apps/backend/src/modules/22-documents/outbox-consumers/decide-document-request.ts — M22-T06 the §4.11
// outbox-subscription decision core. PHASE-1 PURE DECISION CORE (M6-T11 / M7-T08 precedent).
//
// M22 subscribes to the `*.document_requested` render-handshake events every source module emits when it
// wants a PDF materialized (§4.11 table): M6 (election/cti/f2f/nor/revocation/discharge), M9 (assessment
// record), M11 (order record), M12 (medication order), M13 (eMAR / reconciliation worksheet), M14 (IDG
// packet / minutes), M16 (bereavement / anniversary letters), and M23 (ABN, forward-seam). Each event
// names ONE template key + carries a typed payload; M22 resolves the template descriptor, plans a render
// (the T04 `DocumentRenderer` logic), and — once the bytes land — emits `m22.document.rendered` so the
// requesting module's own `m22-document-backref` consumer can apply `document_id` (the W2 §7.2 handshake's
// downstream half). This file ships the PURE, fully-tested {@link decideDocumentRequest}; the live wiring
// (binding the boot outbox dispatcher to this decider + executing the returned action through the T04
// renderer seam + the M1 outbox) is forward-declared/deferred in ./bindings.ts.
//
// Why local types, no producer imports: M22 `dependsOn` is `[1, 5]` (§ manifest). M22 reads every source
// module SOLELY through the foundation outbox event STRING — never a `dependsOn` edge or a producer-package
// import. So the consumed event names are STRING literals and the consumed payload is a locally-declared
// structural minimum (the source module owns the canonical wire payload). This directory is NOT scanned by
// arch:gaps' event-catalog / seam-registry gates, so consuming `m6.*`/`m11.*`/… here adds no M22-produced
// event and no edge. Idempotency follows the M6-T11 D14 rail: a prior `m22.document.rendered` for the same
// `(sourceEvent, aggregateId)` → `idempotent_skip` (re-delivery never double-renders).
import type { DocumentAggregateType, DocumentRetentionClass } from "@wardenx/types";

// ── The §4.11 `*.document_requested` events M22 renders (string literals — no producer import) ──────────

/** The eight source-module render-request event names M22 subscribes to (§4.11). One template per event;
 * M6's discharge/election variants are discriminated by the payload, not the event name. */
export const M22_DOCUMENT_REQUEST_EVENTS = [
  "m6.document_requested", // election_statement / cti / f2f / nor / revocation / discharge_summary
  "m9.assessment.document_requested", // assessment record PDF
  "m11.order.document_requested", // order_record
  "m12.medication_order.document_requested", // medication_order
  "m13.reconciliation.document_requested", // medication_reconciliation_worksheet
  "m14.packet.document_requested", // idg_patient_packet / idg_minutes
  "m16.bereavement.document_requested", // bereavement_letter (letterKind discriminator)
  "m23.abn.document_requested", // abn (forward seam — M23 not yet landed)
] as const;

/** One of the §4.11 render-request event names M22 consumes. */
export type DocumentRequestEvent = (typeof M22_DOCUMENT_REQUEST_EVENTS)[number];

/** The §4.11 render-request payload, as the source module hands it on the outbox (structural minimum). The
 * source module owns the canonical superset; M22 reads only the fields it needs to resolve the template +
 * shape the row + the back-ref. `templateKey` selects the descriptor; `aggregateId` is the source artifact
 * the rendered document back-refs (the value M22 returns in `m22.document.rendered`). */
export interface DocumentRequestPayload {
  readonly organizationId: string;
  /** The published template key the source module is requesting (`cti`, `order_record`, `bereavement_letter`, …). */
  readonly templateKey: string;
  /** The source artifact id the rendered document materializes (back-ref target). */
  readonly aggregateId: string;
  /** The chart-target patient, or null for patient-independent renders (intake / batch). */
  readonly patientId?: string | null;
  /** The template content payload, passed straight to the byte renderer (template-specific). */
  readonly content?: Record<string, unknown>;
  /** True when the requested template is a 42 CFR Part 2 / SUD-class artifact (gates on M39 consent). */
  readonly isSudClass?: boolean;
  /** Present only on out-of-network disclosure paths — the M40 partner entity the render targets. */
  readonly externalRecipient?: ExternalRecipientRef;
  /** Optional override title for the rendered document. */
  readonly title?: string;
}

/** An out-of-network disclosure recipient (§4.12) — gated by the M40 `BaaStatusProvider` before presign. */
export interface ExternalRecipientRef {
  readonly kind: "facility" | "payer" | "referral_source" | "dme_vendor" | "funeral_home";
  readonly mdmEntityId: string;
}

// ── The facts the live consumer resolves before deciding (kept as data so the decider stays pure) ───────

/** Everything the §4.11 consumer reads before it can decide a render, surfaced as data so
 * {@link decideDocumentRequest} stays pure. The Wave-F/live consumer resolves these from the outbox-dedup
 * registry (idempotency), the T04 template table (`templateKnown`/`aggregateType`/`retentionClass`), the
 * M39 `ConsentEvaluator` seam (`sudConsentPresent`), and the M40 `BaaStatusProvider` seam (`externalBaaActive`). */
export interface DocumentRequestFacts {
  /** A prior `m22.document.rendered` already back-refs this `(sourceEvent, aggregateId)` (idempotency, D14). */
  readonly alreadyRendered: boolean;
  /** The requested `templateKey` resolves to a published template descriptor (T04 lookup). */
  readonly templateKnown: boolean;
  /** The `document.aggregate_type` the resolved template produces (from the T04 descriptor). */
  readonly aggregateType: DocumentAggregateType | null;
  /** The INSERT-time retention class the resolved template carries (D23; never updated). */
  readonly retentionClass: DocumentRetentionClass | null;
  /** For a SUD-class request: the M39 `ConsentEvaluator` returned an active `42_cfr_part_2_release` consent.
   * Resolved ONLY when `payload.isSudClass` (the consumer skips the seam call otherwise). */
  readonly sudConsentPresent?: boolean;
  /** For an external-disclosure request: the M40 `BaaStatusProvider` BAA gate is active as-of now (§4.12).
   * Resolved ONLY when `payload.externalRecipient` is present. */
  readonly externalBaaActive?: boolean;
}

// ── The action the decider returns (executed by the live consumer) ──────────────────────────────────────

/** A planned render — the live consumer calls the T04 `DocumentRenderer.render(scope, templateKey, payload)`
 * with exactly these args, then emits `m22.document.rendered` carrying the {@link DocumentBackRef}. */
export interface PlannedRender {
  readonly templateKey: string;
  readonly aggregateType: DocumentAggregateType;
  readonly retentionClass: DocumentRetentionClass;
  readonly aggregateId: string;
  readonly patientId: string | null;
  readonly title?: string;
  readonly content: Record<string, unknown>;
  /** True when the render payload was SUD-redacted at the gate (D20-style metadata flag on the document). */
  readonly sudRedacted: boolean;
}

/** The back-ref M22 emits on `m22.document.rendered` so the requesting module can apply `document_id`. The
 * live consumer fills `documentId` from the renderer return; the decider fixes the routing fields. */
export interface DocumentBackRef {
  readonly sourceEvent: DocumentRequestEvent;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string;
  readonly retentionClass: DocumentRetentionClass;
}

/** The single effect the §4.11 decider resolves for one delivered `*.document_requested` event. */
export type DocumentRequestAction =
  /** A re-delivery of an already-rendered request — skip, no duplicate document (idempotency, D14). */
  | { readonly kind: "idempotent_skip" }
  /** The requested template key has no published descriptor — the worker retries-then-dead-letters (§7.2);
   * NO `document` row is created (matches T04 `UnknownTemplateError`). */
  | { readonly kind: "unknown_template"; readonly templateKey: string }
  /** A SUD-class render with no active M39 consent (§4.11 / §7.16) — refuse; do NOT render plaintext SUD. */
  | { readonly kind: "sud_consent_absent"; readonly templateKey: string }
  /** An external-disclosure render whose M40 BAA gate is not active (§4.12) — block; no presigned URL. */
  | { readonly kind: "baa_inactive"; readonly mdmEntityId: string }
  /** The happy path — render the template + emit `m22.document.rendered` with the back-ref. */
  | { readonly kind: "render"; readonly render: PlannedRender; readonly backRef: DocumentBackRef };

// ── The pure decision core (§4.11 / §4.12) ──────────────────────────────────────────────────────────────

/**
 * Decide the single effect to apply for one delivered `*.document_requested` event (§4.11, pure). The live
 * consumer resolves {@link DocumentRequestFacts} from the outbox-dedup registry + the T04 template table +
 * (when needed) the M39 `ConsentEvaluator` and M40 `BaaStatusProvider` seams, then this returns the
 * {@link DocumentRequestAction} to execute. Gate order mirrors the spec: idempotency → template-known →
 * §7.16 SUD-consent gate → §4.12 external-BAA gate → render.
 */
export function decideDocumentRequest(
  sourceEvent: DocumentRequestEvent,
  payload: DocumentRequestPayload,
  facts: DocumentRequestFacts,
): DocumentRequestAction {
  // 1. Idempotency (D14): a re-delivery never produces a second document for the same source artifact.
  if (facts.alreadyRendered) return { kind: "idempotent_skip" };

  // 2. Template resolution (§7.2): an unknown key is retried-then-dead-lettered; no document row is created.
  if (!facts.templateKnown || facts.aggregateType === null || facts.retentionClass === null) {
    return { kind: "unknown_template", templateKey: payload.templateKey };
  }

  // 3. §7.16 SUD-consent gate: a SUD-class artifact never renders plaintext SUD without an active M39 consent.
  if (payload.isSudClass === true && facts.sudConsentPresent !== true) {
    return { kind: "sud_consent_absent", templateKey: payload.templateKey };
  }

  // 4. §4.12 external-disclosure gate: an out-of-network render is blocked unless the M40 BAA gate is active.
  if (payload.externalRecipient && facts.externalBaaActive !== true) {
    return { kind: "baa_inactive", mdmEntityId: payload.externalRecipient.mdmEntityId };
  }

  // 5. Happy path — plan the render + the back-ref the requesting module links on.
  const render: PlannedRender = {
    templateKey: payload.templateKey,
    aggregateType: facts.aggregateType,
    retentionClass: facts.retentionClass,
    aggregateId: payload.aggregateId,
    patientId: payload.patientId ?? null,
    title: payload.title,
    content: payload.content ?? {},
    sudRedacted: payload.isSudClass === true, // consent present → render, flagged SUD for metadata
  };
  const backRef: DocumentBackRef = {
    sourceEvent,
    aggregateType: facts.aggregateType,
    aggregateId: payload.aggregateId,
    retentionClass: facts.retentionClass,
  };
  return { kind: "render", render, backRef };
}

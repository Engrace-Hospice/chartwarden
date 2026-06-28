// apps/backend/src/modules/23-billing-medicare/consumers/document-render.ts — the M22 PDF render+store
// HANDSHAKE (spec §4.4 "22 (Document Management)" + §4.10 `m23.billing.document_render_requested` + §10
// task 57 inbound / task 58 outbound). This is the single home for BOTH halves of the handshake so the
// `kind → aggregate → back-ref column` mapping is defined ONCE:
//   • OUTBOUND (task 58): the typed builders the noe/notr submit workers + the 277CA ack consumer call to
//     emit `m23.billing.document_render_requested` (kind = receipt / ack letter / denial-appeal cover).
//   • INBOUND (task 57): the pure resolver `resolveDocumentBackRefTarget` the `m22.document.rendered`
//     handler reads to write the returned `document_id` back onto the originating M23 row.
//
// PURE. No DB, no Fastify, no BullMQ, no M22 import — the event STRING + the payload SHAPE is the contract.
// NO PHI / MBI in any render payload (D13, §3.6) — payloads carry IDs + control numbers + the minimal
// human-facing fields M22's template needs; the MBI is never included.

/**
 * The four M22 render kinds M23 requests (§4.10). Local union (mirrors the events-by-m23.ts payload literal)
 * so this file stays pure — it does not import the catalog's TypeBox schema.
 */
export type M23DocumentRenderKind =
  | "noe_confirmation_receipt"
  | "notr_confirmation_receipt"
  | "claim_acknowledgment_letter"
  | "denial_appeal_cover_letter";

/** The `m23.billing.document_render_requested` payload (§4.10): the kind, the originating row, the data. */
export interface DocumentRenderRequestPayload {
  readonly kind: M23DocumentRenderKind;
  /** The originating M23 aggregate row id (noe_record / notr_record / claim) the receipt back-references. */
  readonly aggregateId: string;
  /** The minimal, PHI-free template payload M22 renders from (control numbers, dates, descriptions). */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The M23 table + column an M22-returned `document_id` is written back onto (task 57). */
export interface DocumentBackRefTarget {
  /** The owning M23 table (`noe_record` / `notr_record` / `claim`). */
  readonly table: "noe_record" | "notr_record" | "claim";
  /** The back-ref column the `document_id` lands on. */
  readonly column: "confirmation_document_id" | "acknowledgment_document_id";
}

/**
 * Resolve, PURELY, which M23 row + column an M22 render kind back-references (the structural spine of the
 * §4.4 handshake). Returns `null` for `denial_appeal_cover_letter` — there is NO dedicated back-ref column on
 * `claim` for the appeal cover letter (the only `claim` document column is `acknowledgment_document_id`), so
 * the inbound handler deliberately does NOT record it; the appeal-letter linkage is tracked by the M25 appeal
 * workflow when M25 lands (fail-closed: M23 never writes a stray back-ref). Total over the four kinds.
 */
export function resolveDocumentBackRefTarget(kind: M23DocumentRenderKind): DocumentBackRefTarget | null {
  switch (kind) {
    case "noe_confirmation_receipt":
      return { table: "noe_record", column: "confirmation_document_id" };
    case "notr_confirmation_receipt":
      return { table: "notr_record", column: "confirmation_document_id" };
    case "claim_acknowledgment_letter":
      return { table: "claim", column: "acknowledgment_document_id" };
    case "denial_appeal_cover_letter":
      return null;
  }
}

// ── OUTBOUND builders (task 58) — the submit workers + ack consumer emit these payloads ────────────────────

/** Build the `m23.billing.document_render_requested` payload for a NOE confirmation receipt (noe.submit). */
export function buildNoeConfirmationReceiptRequest(input: {
  readonly noeId: string;
  readonly noeControlNumber: string;
  readonly submittedAt: string;
}): DocumentRenderRequestPayload {
  return {
    kind: "noe_confirmation_receipt",
    aggregateId: input.noeId,
    payload: { noeControlNumber: input.noeControlNumber, submittedAt: input.submittedAt },
  };
}

/** Build the render payload for a NOTR confirmation receipt (notr.submit). */
export function buildNotrConfirmationReceiptRequest(input: {
  readonly notrId: string;
  readonly notrControlNumber: string;
  readonly submittedAt: string;
}): DocumentRenderRequestPayload {
  return {
    kind: "notr_confirmation_receipt",
    aggregateId: input.notrId,
    payload: { notrControlNumber: input.notrControlNumber, submittedAt: input.submittedAt },
  };
}

/** Build the render payload for a claim acknowledgment letter (277CA ACK_ACCEPTED, for the patient chart). */
export function buildClaimAcknowledgmentLetterRequest(input: {
  readonly claimId: string;
  readonly claimControlNumber: string;
  readonly payerClaimControlNumber: string;
  readonly acknowledgedAt: string;
}): DocumentRenderRequestPayload {
  return {
    kind: "claim_acknowledgment_letter",
    aggregateId: input.claimId,
    payload: {
      claimControlNumber: input.claimControlNumber,
      payerClaimControlNumber: input.payerClaimControlNumber,
      acknowledgedAt: input.acknowledgedAt,
    },
  };
}

/** Build the render payload for a denial-appeal cover letter (claim rejection / denial). */
export function buildDenialAppealCoverLetterRequest(input: {
  readonly claimId: string;
  readonly claimControlNumber: string;
  readonly rejectionStage: string;
  readonly rejectionCodes: readonly string[];
}): DocumentRenderRequestPayload {
  return {
    kind: "denial_appeal_cover_letter",
    aggregateId: input.claimId,
    payload: {
      claimControlNumber: input.claimControlNumber,
      rejectionStage: input.rejectionStage,
      rejectionCodes: [...input.rejectionCodes],
    },
  };
}

/**
 * The same-transaction (D2) emit port the noe/notr submit workers + the 277CA ack consumer call to publish
 * `m23.billing.document_render_requested` through the catalog-validating tx publisher (bindCallerModule
 * "m23"). INJECTED at the composition root; an unbound port is a LAZY fail-closed thunk (throws only when a
 * job runs, RULE 4). Pairs with the inbound `m22.document.rendered` handler that records the returned id.
 */
export interface DocumentRenderRequestEmitter {
  readonly emitDocumentRenderRequested: (request: DocumentRenderRequestPayload) => Promise<void>;
}

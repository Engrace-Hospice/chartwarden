// apps/backend/src/modules/11-orders/seams/m22-order-pdf.ts — M11-T08 the M22 order-PDF forward seam
// (DENY-STUB; M11 §1.3 "Consumed by 22 — order PDF rendering via outbox `m11.order.document_requested`;
// results-PDF rendering via `m11.order.results_received`; M22 renders").
//
// M22 (Document Management) is a Wave-F module. When it lands it will render a signed order (and its lab
// results) to a PDF for the chart / survey-export / portal. Until then M11 declares the consumer-facing
// CONTRACT here and ships a pure DENY-STUB so the binding point is documented and type-checked without
// creating a cross-module coupling:
//   • NO entry in the M1 seam registry (SeamContracts) — wiring lands with M22.
//   • NO `dependsOn` edge in the manifest — M22 is not a dependency; M11 merely emits the typed payload M22
//     will pull when it locks (forward seam, same inert pattern as M9's AssessmentSummaryPdfRenderer and
//     M8's EvvBracketResolver). M11's `dependsOn` is unchanged.
// The deny-stub returns `{ available: false }` so any premature caller fails closed rather than emitting an
// empty/partial document. The REAL payload is the §4.4 `m11.order.document_requested` / `m11.order.
// results_received` outbox event shape — the audit denylist (D11) already scrubs `data.notes` /
// `data.indication` / `data.clinical_justification` upstream, so the PDF render never re-derives redaction.

/** The order projection M22 renders to PDF (the §4.4 document-request payload; free-text scrubbed upstream). */
export interface OrderPdfRenderPayload {
  readonly orderId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly kind: string;
  readonly status: string;
  readonly signedAt: string | null;
  /** Present for lab orders whose results have been attached (the results-PDF variant). */
  readonly observationId?: string;
}

/** Result of an M22 render request: the PDF handle when M22 is bound, or a deny when it is not (Wave F). */
export type OrderPdfResult =
  | { readonly available: true; readonly documentId: string }
  | { readonly available: false; readonly reason: "M22_NOT_BOUND" };

/**
 * The forward-seam M22 implements to render an order PDF. M11 OWNS this contract (it shapes the payload);
 * M22 provides the renderer at its lock. Until then {@link denyStubOrderPdfRenderer} stands in.
 */
export interface OrderPdfRenderer {
  render(organizationId: string, payload: OrderPdfRenderPayload): Promise<OrderPdfResult>;
}

/**
 * The Phase-1 DENY-STUB renderer: M22 is not built (Wave F), so every render fails closed with `M22_NOT_BOUND`.
 * Pure — no I/O. Swapped for M22's real renderer when M22 registers its seam.
 */
export const denyStubOrderPdfRenderer: OrderPdfRenderer = {
  async render() {
    return { available: false, reason: "M22_NOT_BOUND" };
  },
};

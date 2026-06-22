// apps/backend/src/modules/13-emar/seams/m22-administration-pdf.ts — M13-T10 the M22 eMAR/reconciliation-PDF
// forward seam (DENY-STUB; M13 §1.3 "Consumed by 22 — eMAR PDF render via outbox
// `m13.administration_record.document_requested`; medication-reconciliation worksheet PDF via outbox
// `m13.reconciliation.document_requested`").
//
// M22 (Document Management) is a Wave-F module. When it lands it will render a committed administration record
// (or a finalized reconciliation worksheet) to a PDF for the chart / survey-export / portal. Until then M13
// declares the consumer-facing CONTRACT here and ships a pure DENY-STUB so the binding point is documented and
// type-checked without creating a cross-module coupling:
//   • NO entry in the M1 seam registry (SeamContracts) — wiring lands with M22.
//   • NO `dependsOn` edge in the manifest — M22 is not a dependency; M13 merely emits the typed payload M22 will
//     pull when it locks (forward seam, same inert pattern as M12's MedicationOrderPdfRenderer). M13's
//     `dependsOn` ([1,12,36,38]) is unchanged.
// The deny-stub returns `{ available: false }` so any premature caller fails closed rather than emitting an
// empty/partial document. The §7.6 free-text PHI denylist (D12) already scrubs `administration_record.notes` /
// `.refusal_reason` / `.wastage_reason` and the reconciliation/PRN notes upstream, so the PDF render never
// re-derives redaction.

/** The kind of M13 artifact M22 renders to PDF. */
export type AdministrationPdfKind = "administration_record" | "reconciliation_worksheet";

/** The eMAR projection M22 renders to PDF (free-text scrubbed upstream per §7.6 / D12). */
export interface AdministrationPdfRenderPayload {
  readonly kind: AdministrationPdfKind;
  /** The `administration_record.id` (kind=administration_record) or worksheet id (kind=reconciliation_worksheet). */
  readonly subjectId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly status: string;
}

/** Result of an M22 render request: the PDF handle when M22 is bound, or a deny when it is not (Wave F). */
export type AdministrationPdfResult =
  | { readonly available: true; readonly documentId: string }
  | { readonly available: false; readonly reason: "M22_NOT_BOUND" };

/**
 * The forward-seam M22 implements to render an eMAR / reconciliation PDF. M13 OWNS this contract (it shapes the
 * payload); M22 provides the renderer at its lock. Until then {@link denyStubAdministrationPdfRenderer} stands
 * in.
 */
export interface AdministrationPdfRenderer {
  render(
    organizationId: string,
    payload: AdministrationPdfRenderPayload,
  ): Promise<AdministrationPdfResult>;
}

/**
 * The Phase-1 DENY-STUB renderer: M22 is not built (Wave F), so every render fails closed with `M22_NOT_BOUND`.
 * Pure — no I/O. Swapped for M22's real renderer when M22 registers its seam.
 */
export const denyStubAdministrationPdfRenderer: AdministrationPdfRenderer = {
  async render() {
    return { available: false, reason: "M22_NOT_BOUND" };
  },
};

// apps/backend/src/modules/12-dosespot/seams/m22-medication-order-pdf.ts — M12-T09 the M22 medication-order-PDF
// forward seam (DENY-STUB; M12 §1.3 "Consumed by 22 — medication-order PDF rendering for the chart /
// survey-export / portal").
//
// M22 (Document Management) is a Wave-F module. When it lands it will render a signed medication order to a PDF
// for the chart / survey-export / portal. Until then M12 declares the consumer-facing CONTRACT here and ships a
// pure DENY-STUB so the binding point is documented and type-checked without creating a cross-module coupling:
//   • NO entry in the M1 seam registry (SeamContracts) — wiring lands with M22.
//   • NO `dependsOn` edge in the manifest — M22 is not a dependency; M12 merely emits the typed payload M22
//     will pull when it locks (forward seam, same inert pattern as M11's OrderPdfRenderer). M12's `dependsOn`
//     ([1,5,11,38,40]) is unchanged.
// The deny-stub returns `{ available: false }` so any premature caller fails closed rather than emitting an
// empty/partial document. The §7.6 free-text PHI denylist (D14) already scrubs `data.sig_free_text` /
// `data.indication` / `data.clinical_justification` / `data.notes` upstream, so the PDF render never
// re-derives redaction.

/** The medication-order projection M22 renders to PDF (free-text scrubbed upstream per §7.6 / D14). */
export interface MedicationOrderPdfRenderPayload {
  readonly medicationOrderId: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly drugName: string;
  readonly status: string;
  readonly isControlledSubstance: boolean;
  readonly signedAt: string | null;
}

/** Result of an M22 render request: the PDF handle when M22 is bound, or a deny when it is not (Wave F). */
export type MedicationOrderPdfResult =
  | { readonly available: true; readonly documentId: string }
  | { readonly available: false; readonly reason: "M22_NOT_BOUND" };

/**
 * The forward-seam M22 implements to render a medication-order PDF. M12 OWNS this contract (it shapes the
 * payload); M22 provides the renderer at its lock. Until then {@link denyStubMedicationOrderPdfRenderer}
 * stands in.
 */
export interface MedicationOrderPdfRenderer {
  render(
    organizationId: string,
    payload: MedicationOrderPdfRenderPayload,
  ): Promise<MedicationOrderPdfResult>;
}

/**
 * The Phase-1 DENY-STUB renderer: M22 is not built (Wave F), so every render fails closed with `M22_NOT_BOUND`.
 * Pure — no I/O. Swapped for M22's real renderer when M22 registers its seam.
 */
export const denyStubMedicationOrderPdfRenderer: MedicationOrderPdfRenderer = {
  async render() {
    return { available: false, reason: "M22_NOT_BOUND" };
  },
};

// apps/backend/src/modules/09-assessments/seams/m22-summary-pdf.ts — M9-T07 the M22 assessment-summary
// PDF forward seam (DENY-STUB; M9 §12 forward seam "M22 PDF render consumes the summary projection when M22
// locks", §5.1 Assessment-summary view).
//
// M22 (Documents) is a Wave-F module. When it lands it will render a patient's assessment-summary projection
// to a PDF for the chart/portal/AoD. Until then M9 declares the consumer-facing CONTRACT here and ships a pure
// DENY-STUB so the binding point is documented and type-checked without creating a cross-module coupling:
//   • NO entry in the M1 seam registry (SeamContracts) — wiring lands with M22.
//   • NO `dependsOn` edge in the manifest — M22 is not a dependency; M9 merely exposes a projection M22 will
//     pull when it locks (forward seam, same inert pattern as M8's EvvBracketResolver / M17 visit-seeding).
// The deny-stub returns `{ available: false }` so any premature caller fails closed rather than emitting an
// empty/partial document. The REAL projection is the same summary the §5.2 Assessment-summary screen reads
// (GET /patients/:patientId/assessments/summary) — SUD content is already filtered SERVER-side (§7.6) before
// it reaches this seam, so the PDF render never re-derives redaction.

/** The summary projection M22 renders to PDF (the §5.2 summary shape, SUD-filtered upstream). */
export interface AssessmentSummaryRenderPayload {
  readonly patientId: string;
  readonly generatedAt: string;
  readonly scales: ReadonlyArray<{
    readonly scaleType: string;
    readonly score: number | null;
    readonly scoreInterpretation: string | null;
    readonly capturedAt: string;
  }>;
}

/** Result of an M22 render request: the PDF bytes/handle when M22 is bound, or a deny when it is not (Wave F). */
export type AssessmentSummaryPdfResult =
  | { readonly available: true; readonly documentId: string }
  | { readonly available: false; readonly reason: "M22_NOT_BOUND" };

/**
 * The forward-seam M22 implements to render an assessment-summary PDF. M9 OWNS this contract (it shapes the
 * payload); M22 provides the renderer at its lock. Until then {@link denyStubAssessmentSummaryPdfRenderer}
 * stands in.
 */
export interface AssessmentSummaryPdfRenderer {
  render(organizationId: string, payload: AssessmentSummaryRenderPayload): Promise<AssessmentSummaryPdfResult>;
}

/**
 * The Phase-1 DENY-STUB renderer: M22 is not built (Wave F), so every render fails closed with `M22_NOT_BOUND`.
 * Pure — no I/O. Swapped for M22's real renderer when M22 registers its seam.
 */
export const denyStubAssessmentSummaryPdfRenderer: AssessmentSummaryPdfRenderer = {
  async render() {
    return { available: false, reason: "M22_NOT_BOUND" };
  },
};

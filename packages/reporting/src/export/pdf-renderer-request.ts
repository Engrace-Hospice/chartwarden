// @wardenx/reporting · export — the PDF export render-request handler (M33 §4.8 `report.export_render` / D10).
//
// The body of the `report.export_render` worker for `format=pdf`: gate the resolved row count against the §4.8
// PDF cap (≤ 5000 rows — Puppeteer paginates M33's printable HTML template), then emit the §1.1
// `m33.scheduled_report.render_requested` handshake to M22 and park the export awaiting `m22.document.rendered`.
// Idempotent on the document handshake (`idempotencyKey = exportId`).
//
// PURE port-injected orchestration: the gate + payload build are total pure functions; the emit is the injected
// {@link ExportRenderOutboxPort}. No clock/RNG/Drizzle/BullMQ/M22 import (the `runner.ts` precedent).
import {
  type ExportRenderOutboxPort,
  type ExportRenderRequestInput,
  type ExportRenderRequestResult,
  assertPdfRowLimit,
  buildExportRenderRequest,
} from "./render-request";

/** The ports the PDF render-request handler composes over (just the render-request outbox emit). */
export interface PdfRenderRequestPorts {
  readonly outbox: ExportRenderOutboxPort;
}

/**
 * Request a PDF render for one export (§4.8 / D10). Applies the §4.8 PDF row cap FIRST (throws
 * {@link PdfRowLimitExceeded} → the route surfaces 413 `PDF_ROW_LIMIT_EXCEEDED`; no render is requested), then
 * emits the `m33.scheduled_report.render_requested` handshake with `format=pdf`. Idempotent on the handshake.
 *
 * @throws {PdfRowLimitExceeded} the resolved row count exceeds {@link PDF_MAX_ROW_LIMIT}
 */
export async function requestPdfRender(
  input: ExportRenderRequestInput,
  ports: PdfRenderRequestPorts,
): Promise<ExportRenderRequestResult> {
  // §4.8 gate FIRST — fail-closed before any handshake is emitted.
  assertPdfRowLimit(input.rowLimit);

  const payload = buildExportRenderRequest(input, "pdf");
  await ports.outbox.emitRenderRequested(payload);
  return { kind: "render_requested", payload };
}

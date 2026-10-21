// @chartwarden/reporting · export — the XLSX export render-request handler (M33 §4.8 `report.export_render` / D10).
//
// The body of the `report.export_render` worker for `format=xlsx`: emit the §1.1
// `m33.scheduled_report.render_requested` handshake to M22 (its file pipeline turns the M33 snapshot result into
// a styled `.xlsx`) and park the export awaiting `m22.document.rendered`. Idempotent on the document handshake
// (`idempotencyKey = exportId`). Unlike PDF, XLSX carries NO row cap here — M22 chunk-renders larger sets (the
// §4.8 W-R-08 cap-exceeded recommendation steers oversize CSV exports to XLSX).
//
// PURE port-injected orchestration: the payload build is a total pure function; the emit is the injected
// {@link ExportRenderOutboxPort}. No clock/RNG/Drizzle/BullMQ/M22 import (the `runner.ts` precedent).
import {
  type ExportRenderOutboxPort,
  type ExportRenderRequestInput,
  type ExportRenderRequestResult,
  buildExportRenderRequest,
} from "./render-request";

/** The ports the XLSX render-request handler composes over (just the render-request outbox emit). */
export interface XlsxRenderRequestPorts {
  readonly outbox: ExportRenderOutboxPort;
}

/**
 * Request an XLSX render for one export (§4.8 / D10). Emits the `m33.scheduled_report.render_requested`
 * handshake with `format=xlsx`; no per-format row gate (M22 chunk-renders). Idempotent on the handshake.
 */
export async function requestXlsxRender(
  input: ExportRenderRequestInput,
  ports: XlsxRenderRequestPorts,
): Promise<ExportRenderRequestResult> {
  const payload = buildExportRenderRequest(input, "xlsx");
  await ports.outbox.emitRenderRequested(payload);
  return { kind: "render_requested", payload };
}

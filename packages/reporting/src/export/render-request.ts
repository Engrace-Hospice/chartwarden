// @wardenx/reporting · export — the shared M22 render-request contract for the PDF + XLSX export paths
// (M33 §4.8 `report.export_render` / D7 / D10).
//
// PDF and XLSX exports are NOT streamed by M33: M33 builds the snapshot query, then hands the render to M22 via
// the §1.1 render handshake — it emits `m33.scheduled_report.render_requested` with `format=pdf|xlsx` and an
// `idempotencyKey`; M22 (Puppeteer for PDF / file pipeline for XLSX) renders + stores the artifact and replies
// `m22.document.rendered` carrying the new `document_id`, keyed back by the export's `aggregateId`. This module
// holds the format-agnostic pieces both export handlers compose over; `pdf-renderer-request.ts` /
// `xlsx-renderer-request.ts` add the per-format gates.
//
// PURE port-injected orchestration (the scheduled `runner.ts` precedent): the request build is a total pure
// function; the emit is an injected outbox port. No clock/RNG/Drizzle/BullMQ/M22 import — M33 reads M22 SOLELY
// through the outbox event STRING, so this adds NO new manifest `dependsOn` edge. The reply consumer + the live
// outbox dispatcher binding land at app boot (P2C).

/** The two M22-rendered export formats (CSV takes no M22 hop — see `csv-stream.ts`). */
export type ExportRenderFormat = "pdf" | "xlsx";

/** The render-request event M22 consumes (the SAME wire the scheduled runner uses, §4.10 / D7). M22 replies
 *  `m22.document.rendered` (the downstream half lives in `scheduled/delivery.ts`). */
export const M33_EXPORT_RENDER_REQUESTED = "m33.scheduled_report.render_requested" as const;

/** The `aggregate_type` an ad-hoc export's render-request names, so a future back-ref consumer acts only on an
 *  export reply (never a scheduled-run reply, which carries `report_schedule_run`) on the shared dispatcher. */
export const M33_EXPORT_AGGREGATE_TYPE = "report_export" as const;

/** §4.8 / D10: a PDF render is gated to `row_limit ≤ 5000` (Puppeteer paginates HTML; larger sets use XLSX/CSV). */
export const PDF_MAX_ROW_LIMIT = 5_000 as const;

// ── the render-request payload ────────────────────────────────────────────────────────────────────────────

/** The fields an export handler needs to build a render-request (the resolved snapshot + its identity). */
export interface ExportRenderRequestInput {
  /** The export job id — the §2.6 idempotency oracle + the `aggregateId` M22 keys its reply back by. */
  readonly exportId: string;
  /** The saved view the export materializes. */
  readonly viewId: string;
  readonly organizationId: string;
  /** The parameterized snapshot SELECT the translator built (aggregate-only; no row-level PHI, D6). */
  readonly snapshotQuery: string;
  /** The view's resolved row limit (drives the PDF §4.8 gate). */
  readonly rowLimit: number;
}

/** The typed `m33.scheduled_report.render_requested` payload M22 consumes (§4.10). `idempotencyKey = exportId`
 *  gives M22 at-most-once render across a redelivered request (idempotent on the document handshake, D10). */
export interface ExportRenderRequestPayload {
  readonly exportId: string;
  readonly viewId: string;
  readonly format: ExportRenderFormat;
  readonly organizationId: string;
  readonly snapshotQuery: string;
  readonly idempotencyKey: string;
  /** The §1.1 back-ref discriminator the reply consumer matches on (so it acts only on export replies). */
  readonly aggregateType: typeof M33_EXPORT_AGGREGATE_TYPE;
  readonly aggregateId: string;
}

/** The injected outbox port the export handlers emit the render-request through (bound to the live transactional
 *  outbox at P2C; a fail-closed thunk until then — the `runner.ts` `RunnerOutboxPort` precedent). */
export interface ExportRenderOutboxPort {
  emitRenderRequested(payload: ExportRenderRequestPayload): Promise<void>;
}

/** Raised when a PDF export's resolved row count exceeds the §4.8 PDF cap — the route surfaces 413
 *  `PDF_ROW_LIMIT_EXCEEDED` (recommend XLSX/CSV for larger sets). Fail-closed: no render is requested. */
export class PdfRowLimitExceeded extends Error {
  constructor(
    public readonly rowLimit: number,
    public readonly cap: number = PDF_MAX_ROW_LIMIT,
  ) {
    super(`PDF_ROW_LIMIT_EXCEEDED: resolved row limit ${rowLimit} exceeds the PDF cap of ${cap} rows`);
    this.name = "PdfRowLimitExceeded";
  }
}

/** §4.8 PDF gate (PURE): throws {@link PdfRowLimitExceeded} when `rowLimit` exceeds {@link PDF_MAX_ROW_LIMIT}. */
export function assertPdfRowLimit(rowLimit: number, cap: number = PDF_MAX_ROW_LIMIT): void {
  if (rowLimit > cap) throw new PdfRowLimitExceeded(rowLimit, cap);
}

/**
 * Build the typed render-request payload for one export (PURE). `idempotencyKey` + `aggregateId` are both the
 * `exportId` (the at-most-once render oracle + the reply back-ref key). Total — no I/O, no validation beyond the
 * shape; the per-format gate (PDF row cap) is applied by the format handler BEFORE this is emitted.
 */
export function buildExportRenderRequest(
  input: ExportRenderRequestInput,
  format: ExportRenderFormat,
): ExportRenderRequestPayload {
  return {
    exportId: input.exportId,
    viewId: input.viewId,
    format,
    organizationId: input.organizationId,
    snapshotQuery: input.snapshotQuery,
    idempotencyKey: input.exportId,
    aggregateType: M33_EXPORT_AGGREGATE_TYPE,
    aggregateId: input.exportId,
  };
}

/** What one export render-request reported: the emitted payload (the run parks awaiting `m22.document.rendered`). */
export interface ExportRenderRequestResult {
  readonly kind: "render_requested";
  readonly payload: ExportRenderRequestPayload;
}

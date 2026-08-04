// apps/backend/src/modules/33-reporting/routes/exports.routes.ts — M33 (§4.1 #32–#34).
//
// The three export formats (D10):
//   #32 POST /views/:id/export.csv  — direct chunked CSV STREAM off the read replica (NO M22 hop;
//        aggregate-only, D6, statement_timeout=30s). A pre-flight estimate over the §4.8 250k-row cap refuses
//        with 413 BEFORE any byte streams; otherwise the route hijacks the response and streams the snapshot.
//   #33 POST /views/:id/export.pdf  — the §1.1 M22 render handshake (Puppeteer; ≤5000-row gate → 413) → 202.
//   #34 POST /views/:id/export.xlsx — the §1.1 M22 render handshake (file pipeline; no row gate) → 202.
//
// Every route is gated by the REAL Authorization Contract (`requirePermission` + `requireAbac` on the D8
// `reportable_scope` predicate M33 OWNS, M3). PDF/XLSX are idempotency-required (the exportId is the
// `Idempotency-Key` so M22 renders at-most-once across a redelivered request). Org/actor binding is ALWAYS
// server-side (request.context, never the body). Mirrors the M33 schedules/views route shape.
import { requireAbac, requirePermission } from "@wardenx/auth";
import {
  CSV_EXPORT_ROW_CAP,
  CsvExportRowCapExceeded,
  PdfRowLimitExceeded,
} from "@wardenx/reporting";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type PreHandler, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import type { CsvSinkPort, M33ExportDrilldownRouteService } from "./export-drilldown-service";
import { parse } from "./reporting-typebox";
import { ExportRequest, ViewIdParams } from "./write-typebox";

export interface ExportRouteDeps {
  readonly service: M33ExportDrilldownRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
// `reportable_scope` (D8) — the cross-cutting read-scope predicate M33 owns; an export is a scoped read.
const SCOPE = (key: string): PreHandler => requireAbac(key, "reportable_scope") as PreHandler;

const EXPORT_CSV = P("report.export.csv");
const EXPORT_CSV_SCOPE = SCOPE("report.export.csv");
const EXPORT_PDF = P("report.export.pdf");
const EXPORT_PDF_SCOPE = SCOPE("report.export.pdf");
const EXPORT_XLSX = P("report.export.xlsx");
const EXPORT_XLSX_SCOPE = SCOPE("report.export.xlsx");
const IDEMPOTENT = requireIdempotencyKey();

/** The server-assembled `Idempotency-Key` value (the export job id M22 keys its reply back by). */
function idempotencyKeyOf(headers: Record<string, unknown>): string {
  const raw = headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value : "";
}

/** Build a {@link CsvSinkPort} over the hijacked HTTP response (backpressure-honouring chunked writes). */
function csvSinkOf(reply: FastifyReply): CsvSinkPort {
  const raw = reply.raw;
  return {
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        raw.write(chunk, (err) => (err ? reject(err) : resolve()));
      }),
    end: () =>
      new Promise<void>((resolve) => {
        raw.end(resolve);
      }),
  };
}

/** Register the §4.1 export routes (#32–#34). */
export function registerExportRoutes(app: FastifyInstance, deps: ExportRouteDeps): void {
  const { service } = deps;

  // 32 — stream a saved view as CSV (direct replica stream; §4.8 250k cap → 413 before streaming). §4.1.
  app.post(
    "/api/v1/reporting/views/:id/export.csv",
    { preHandler: [EXPORT_CSV, EXPORT_CSV_SCOPE] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ViewIdParams, request.params);
      const body = parse(ExportRequest, request.body);
      const query = { filters: body.filters, scopeOverride: body.scopeOverride };

      // §4.8 cap: refuse over-cap BEFORE any byte streams (no partial response). 413 is a normal JSON reply.
      const estimate = await service.estimateCsvExport(actor, id, query);
      if (estimate.estimatedRowCount > CSV_EXPORT_ROW_CAP) {
        return reply.code(413).send({
          error: "EXPORT_ROW_CAP_EXCEEDED",
          estimatedRowCount: estimate.estimatedRowCount,
          cap: CSV_EXPORT_ROW_CAP,
        });
      }

      // Hijack the response and stream chunked CSV directly (the streamer honours backpressure on the sink).
      reply.raw.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "transfer-encoding": "chunked",
        "content-disposition": `attachment; filename="report-${id}.csv"`,
        "cache-control": "no-store",
      });
      reply.hijack();
      const sink = csvSinkOf(reply);
      try {
        await service.streamCsvExport(actor, id, query, sink);
      } catch (err) {
        // Headers are already sent — a defensive mid-stream cap/error closes the connection (no JSON envelope).
        if (err instanceof CsvExportRowCapExceeded) reply.raw.end();
        else reply.raw.destroy(err instanceof Error ? err : new Error(String(err)));
      }
      return reply;
    },
  );

  // 33 — request a PDF render (§1.1 M22 handshake; ≤5000-row gate → 413). Idempotent. §4.1.
  app.post(
    "/api/v1/reporting/views/:id/export.pdf",
    { preHandler: [EXPORT_PDF, EXPORT_PDF_SCOPE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ViewIdParams, request.params);
      parse(ExportRequest, request.body); // validate the filters/scope envelope (snapshot at render time)
      const idem = idempotencyKeyOf(request.headers as Record<string, unknown>);
      try {
        const res = await service.requestExport(actor, id, "pdf", idem);
        return reply.code(202).send(res);
      } catch (err) {
        if (err instanceof PdfRowLimitExceeded) {
          return reply
            .code(413)
            .send({ error: "PDF_ROW_LIMIT_EXCEEDED", rowLimit: err.rowLimit, cap: err.cap });
        }
        throw err;
      }
    },
  );

  // 34 — request an XLSX render (§1.1 M22 handshake; no row gate). Idempotent. §4.1.
  app.post(
    "/api/v1/reporting/views/:id/export.xlsx",
    { preHandler: [EXPORT_XLSX, EXPORT_XLSX_SCOPE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ViewIdParams, request.params);
      parse(ExportRequest, request.body);
      const idem = idempotencyKeyOf(request.headers as Record<string, unknown>);
      const res = await service.requestExport(actor, id, "xlsx", idem);
      return reply.code(202).send(res);
    },
  );
}

// apps/backend/src/modules/33-reporting/routes/drilldown.routes.ts — M33 (§4.1 #35–#36).
//
// The drilldown surface (D6/D16 — navigation-as-disclosure):
//   #35 POST /drilldown/emit         — resolve a tile's `drilldown_url_template` + the dimension context into a
//        candidate owner-module URL, NARROW it for M39 consent (fail-closed; never refused, never widened), and
//        write the envelope-encrypted `report_drilldown_audit` row (W-R-05). `reportable_scope` (D8) + idempotent.
//   #36 POST /drilldown/bulk_export  — the Compliance bulk drilldown export (a CSV of patient-identifiable
//        navigation links). The narrowest sensitive surface: `report.drilldown.bulk_export` (org-admin-carried)
//        + a recent M2 SESSION_POLICY STEP-UP + a valid DEVICE ATTESTATION (SecHardening §12.4 — a non-attested
//        device is refused) + idempotent. Streams chunked CSV off the read replica.
//
// Every route is gated by the REAL Authorization Contract (`requirePermission` + `requireAbac` / `requireStepUp`
// from @wardenx/auth, M3). Org/actor binding is ALWAYS server-side (request.context, never the body).
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type PreHandler, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import type { CsvSinkPort, M33ExportDrilldownRouteService } from "./export-drilldown-service";
import { parse } from "./reporting-typebox";
import { DrilldownBulkExportRequest, DrilldownEmitRequest } from "./write-typebox";

export interface DrilldownRouteDeps {
  readonly service: M33ExportDrilldownRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const SCOPE = (key: string): PreHandler => requireAbac(key, "reportable_scope") as PreHandler;

const DRILL_EMIT = P("report.drilldown.read");
const DRILL_EMIT_SCOPE = SCOPE("report.drilldown.read");
const DRILL_BULK = P("report.drilldown.bulk_export");
// §6/D11 step-up: the bulk PHI-identifiable export requires a recent step-up (the op key drives the freshness policy).
const STEPUP_BULK = requireStepUp("report.drilldown.bulk_export") as PreHandler;
// SecHardening §12.4: the bulk export refuses from a non-attested device (`device_attestation_valid`, the shared
// D8 predicate; deny-by-default when unresolved — fail-closed, never an un-attested bulk PHI export).
//
// THIS ROUTE IS CLOSED TO EVERYONE TODAY, BY DESIGN. Nothing yet PRODUCES an attestation — M2 owns no
// `device_attestation` table (ADR-0023 D2), the request context hard-codes `attributes: {}`, and the mobile
// client that runs the §12.4 posture check is unbuilt (ADR-0035) — so the predicate denies every caller. The
// deny is semantic (see `deviceAttestationValid` in @wardenx/auth), not a missing registration; it lifts on its
// own when M2 lands the attestation surface, with no change here. Do not "fix" it by dropping this preHandler.
const DEVICE_ATTESTED = requireAbac(
  "report.drilldown.bulk_export",
  "device_attestation_valid",
) as PreHandler;
const IDEMPOTENT = requireIdempotencyKey();

/** Build a {@link CsvSinkPort} over the hijacked HTTP response. */
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

/** Register the §4.1 drilldown routes (#35–#36). */
export function registerDrilldownRoutes(app: FastifyInstance, deps: DrilldownRouteDeps): void {
  const { service } = deps;

  // 35 — emit a consent-narrowed drilldown URL + write the audit row (W-R-05). Idempotent. §4.1.
  app.post(
    "/api/v1/reporting/drilldown/emit",
    { preHandler: [DRILL_EMIT, DRILL_EMIT_SCOPE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(DrilldownEmitRequest, request.body);
      const res = await service.emitDrilldown(actor, {
        tileKey: body.tileKey,
        reportViewId: body.reportViewId ?? null,
        dimensionContext: body.dimensionContext,
        queryFilters: body.queryFilters,
        patientIds: body.patientIds,
      });
      return reply.code(201).send(res);
    },
  );

  // 36 — Compliance bulk drilldown export (STEP-UP + device attestation; §12.4). Streams CSV. §4.1.
  app.post(
    "/api/v1/reporting/drilldown/bulk_export",
    { preHandler: [DRILL_BULK, STEPUP_BULK, DEVICE_ATTESTED, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(DrilldownBulkExportRequest, request.body);

      reply.raw.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "transfer-encoding": "chunked",
        "content-disposition": 'attachment; filename="drilldown-bulk-export.csv"',
        "cache-control": "no-store",
      });
      reply.hijack();
      const sink = csvSinkOf(reply);
      try {
        await service.bulkExportDrilldown(
          actor,
          { targetModule: body.targetModule, dimensionContext: body.dimensionContext },
          sink,
        );
      } catch (err) {
        reply.raw.destroy(err instanceof Error ? err : new Error(String(err)));
      }
      return reply;
    },
  );
}

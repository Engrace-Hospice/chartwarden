// apps/backend/src/modules/33-reporting/routes/bases-metrics.routes.ts — M33 (§4.1 #5–#7).
//
// The platform-shipped report-builder catalog reads: list/read report bases (the base picker the
// report-definition author selects dimensions/measures FROM, D4) + list the metric catalog. The bases /
// metrics catalogs are PLATFORM-scoped (NO organization_id; org-readable via GRANT); these keys carry no
// per-row ABAC (`abac:"none"` in M33_CONTRIBUTED_PERMISSIONS) — `requirePermission` on the §4.6 keys is
// the full gate. Every read still runs through the injected service → `withReportSession` (§8.1.2 / D3).
// Org/actor binding is ALWAYS server-side (request.context). Mirrors M34 routes/platform/tenants.ts.
import { requirePermission } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf } from "./actor";
import type { M33ReadRouteService } from "./read-service";
import {
  BaseKeyParamsSchema,
  BaseListQuerySchema,
  MetricListQuerySchema,
  parse,
} from "./reporting-typebox";

export interface BaseMetricRouteDeps {
  readonly service: M33ReadRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const BASE_LIST = P("report.base.list");
const BASE_READ = P("report.base.read");
const METRIC_LIST = P("report.metric.list");

/** Register the §4.1 report-base + metric-catalog READ routes (#5–#7). */
export function registerBaseMetricRoutes(app: FastifyInstance, deps: BaseMetricRouteDeps): void {
  const { service } = deps;

  // 5 — list report bases (filter by status; cursor-paginated). §4.1.
  app.get("/api/v1/reporting/bases", { preHandler: [BASE_LIST] }, async (request) => {
    const actor = actorOf(request);
    const q = parse(BaseListQuerySchema, request.query);
    return service.listBases(actor, { status: q.status }, q.cursor, q.limit);
  });

  // 6 — read one report base (dimensions + measures + drilldown template; the author's column picker). §4.1.
  app.get("/api/v1/reporting/bases/:baseKey", { preHandler: [BASE_READ] }, async (request) => {
    const actor = actorOf(request);
    const { baseKey } = parse(BaseKeyParamsSchema, request.params);
    return service.getBase(actor, baseKey);
  });

  // 7 — list the metric catalog (filter by status; cursor-paginated). §4.1.
  app.get("/api/v1/reporting/metrics", { preHandler: [METRIC_LIST] }, async (request) => {
    const actor = actorOf(request);
    const q = parse(MetricListQuerySchema, request.query);
    return service.listMetrics(actor, { status: q.status }, q.cursor, q.limit);
  });
}

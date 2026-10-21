// apps/backend/src/modules/33-reporting/routes/metrics-seam.routes.ts — M33 (§4.1 #42 / §4.3).
//
// The internal published-seam HTTP endpoint backing `MetricsProvider.getDashboardMetric` — consumed by
// M30 (HQRP measure-detail embed), M34 (tenant ops console), and M37 (IPU dashboard embed) for embedded
// dashboard tiles. Aggregate-by-default (D6 — no row-level PHI crosses this seam) and scoped to the
// actor's org. Gated by `report.metric.list` (the internal seam authority — the consuming module's
// service holds the key); the read runs through the injected service → `withReportSession` /
// MetricsProvider. Returns a `null` value + `isForwardSeamDenyStub:true` when the metric is not yet
// materialized (a forward-seam MV). Org/actor binding is ALWAYS server-side (request.context).
import { requirePermission } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf } from "./actor";
import type { M33ReadRouteService } from "./read-service";
import { MetricKeyParamsSchema, MetricSeamQuerySchema, parse } from "./reporting-typebox";

export interface MetricsSeamRouteDeps {
  readonly service: M33ReadRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const METRIC_SEAM = P("report.metric.list");

/** Register the §4.3 internal MetricsProvider seam endpoint (#42). */
export function registerMetricsSeamRoutes(app: FastifyInstance, deps: MetricsSeamRouteDeps): void {
  const { service } = deps;

  // 42 — read a single dashboard metric at an as-of / window (backs the MetricsProvider seam). §4.3.
  app.get(
    "/api/v1/reporting/metrics_seam/dashboard/:metricKey",
    { preHandler: [METRIC_SEAM] },
    async (request) => {
      const actor = actorOf(request);
      const { metricKey } = parse(MetricKeyParamsSchema, request.params);
      const q = parse(MetricSeamQuerySchema, request.query);
      const period = q.from && q.to ? { from: q.from, to: q.to } : undefined;
      return service.getDashboardMetricSeam(actor, metricKey, { asOf: q.asOf, period });
    },
  );
}

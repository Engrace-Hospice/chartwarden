// apps/backend/src/modules/23-billing-medicare/routes/metrics.routes.ts — M23 (§4.1 dashboards/metrics).
//
// The aggregate-only reporting surface (no row-level PHI): the AR-aging dashboard (aging buckets + denial /
// NOE-NOTR window-breach rates) and the per-window claim metrics the M33 reporting consumer projects. Both
// are org-scoped rollups optionally narrowed to one ProviderEntity (`?providerEntityId=`). The AR dashboard
// gates `billing.claim.read_ar_dashboard`; the metrics endpoint gates `billing.claim.read_metrics` (both the
// `inOrg` §4.6 default — these are org-wide rollups, not per-claim caseload reads). Org/actor binding is
// ALWAYS server-side; the read services open one `withOrgContext` tx per call (RLS).
import type { FastifyInstance } from "fastify";
import { actorOf } from "./actor";
import { MetricsQuerySchema, parse } from "./billing-typebox";
import { P } from "./guards";
import type { M23ReadRouteService } from "./read-service";

export interface MetricsRouteDeps {
  readonly readService: M23ReadRouteService;
}

const READ_AR = P("billing.claim.read_ar_dashboard");
const READ_METRICS = P("billing.claim.read_metrics");

/** Register the §4.1 dashboard/metrics routes (#37–#38). */
export function registerMetricsRoutes(app: FastifyInstance, deps: MetricsRouteDeps): void {
  const { readService } = deps;

  // GET /billing/ar-dashboard?providerEntityId= — AR-aging buckets + rates (org-wide or per-PE). §4.1 #37.
  app.get(
    "/api/v1/billing/ar-dashboard",
    {
      preHandler: [READ_AR],
      config: {
        auditRead: {
          none: "AR aging buckets + open-claim counts in dollars — aggregate, no patient identity",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { providerEntityId } = parse(MetricsQuerySchema, request.query);
      return readService.getArAging(actor, { providerEntityId });
    },
  );

  // GET /billing/metrics?providerEntityId= — per-window claim metric buckets (M33 consumer). §4.1 #38.
  app.get(
    "/api/v1/billing/metrics",
    {
      preHandler: [READ_METRICS],
      config: {
        auditRead: {
          none: "billing throughput/denial-rate metrics — aggregate, no patient identity",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { providerEntityId } = parse(MetricsQuerySchema, request.query);
      return { buckets: await readService.getClaimMetrics(actor, { providerEntityId }) };
    },
  );
}

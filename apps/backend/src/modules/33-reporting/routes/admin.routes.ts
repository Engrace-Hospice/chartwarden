// apps/backend/src/modules/33-reporting/routes/admin.routes.ts — M33 (§4.1 #37–#41).
//
// The platform / compliance admin surface: the materialized-view registry (list / refresh / suspend),
// the replica-lag posture (D14), and the compliance drilldown-audit trail. These are the §4.6
// `reporting_admin` keys (29–33 of M33_CONTRIBUTED_PERMISSIONS); each carries `abac:"none"` in the
// catalog, so `requirePermission` on the admin key is the authoritative gate — the §4.2 route-table's
// `platform_admin_scope` / `compliance_officer_scope` intent is carried by the M3 role assignment for
// the `reporting_admin` category (M33 owns only `reportable_scope` + `dashboard_visibility` as named
// predicates; dedicated platform-scope predicates are a deferred P2C binding, the deny-stub posture).
//
// READS run through the injected service → `withReportSession` (§8.1.2 / D3). The two MUTATING commands
// (MV refresh / suspend) ENQUEUE the on-PRIMARY `report.mv_refresh` worker and return HTTP 202 with the
// job id — idempotent via the deterministic `<mvKey>:<op>` job key (BullMQ jobId dedup; §2.4 / §4.8). The
// refresh never runs on the request thread. Org/actor binding is ALWAYS server-side (request.context).
import { requirePermission } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf } from "./actor";
import type { M33ReadRouteService } from "./read-service";
import {
  DrilldownAuditListQuerySchema,
  MvKeyParamsSchema,
  MvListQuerySchema,
  parse,
} from "./reporting-typebox";

export interface ReportingAdminRouteDeps {
  readonly service: M33ReadRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const MV_LIST = P("report.admin.mv_list");
const MV_REFRESH = P("report.admin.mv_refresh");
const MV_SUSPEND = P("report.admin.mv_suspend");
const LAG_READ = P("report.admin.lag_read");
const AUDIT_READ = P("report.admin.audit_read");

/** Register the §4.1 platform/compliance admin routes (#37–#41). */
export function registerReportingAdminRoutes(app: FastifyInstance, deps: ReportingAdminRouteDeps): void {
  const { service } = deps;

  // 37 — list the registered materialized views (refresh telemetry + status). §4.1.
  app.get("/api/v1/reporting/admin/mvs", { preHandler: [MV_LIST] }, async (request) => {
    const actor = actorOf(request);
    const q = parse(MvListQuerySchema, request.query);
    return service.listMvMetadata(actor, { status: q.status }, q.cursor, q.limit);
  });

  // 38 — refresh an MV (enqueues the on-PRIMARY `report.mv_refresh` worker; 202). §4.1/§2.4.
  app.post(
    "/api/v1/reporting/admin/mvs/:mvKey/refresh",
    { preHandler: [MV_REFRESH] },
    async (request, reply) => {
      const actor = actorOf(request);
      const { mvKey } = parse(MvKeyParamsSchema, request.params);
      const res = await service.refreshMv(actor, mvKey);
      return reply.code(202).send(res);
    },
  );

  // 39 — suspend an MV (halt its refresh schedule; enqueues the lifecycle job; 202). §4.1.
  app.post(
    "/api/v1/reporting/admin/mvs/:mvKey/suspend",
    { preHandler: [MV_SUSPEND] },
    async (request, reply) => {
      const actor = actorOf(request);
      const { mvKey } = parse(MvKeyParamsSchema, request.params);
      const res = await service.suspendMv(actor, mvKey);
      return reply.code(202).send(res);
    },
  );

  // 40 — read the replica-lag posture (the D14 breaker + freshness). §4.1/§4.8.
  app.get("/api/v1/reporting/admin/lag", { preHandler: [LAG_READ] }, async (request) => {
    const actor = actorOf(request);
    return service.getReplicaLag(actor);
  });

  // 41 — query the compliance drilldown-audit trail (filter by target module; `query_filters_cipher`
  //      is DENYLISTED and never projected, §3.6). §4.1.
  app.get(
    "/api/v1/reporting/admin/audit/drilldowns",
    { preHandler: [AUDIT_READ] },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(DrilldownAuditListQuerySchema, request.query);
      return service.listDrilldownAudit(actor, { targetModule: q.targetModule }, q.cursor, q.limit);
    },
  );
}

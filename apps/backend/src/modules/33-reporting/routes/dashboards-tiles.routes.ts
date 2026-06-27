// apps/backend/src/modules/33-reporting/routes/dashboards-tiles.routes.ts — M33 (§4.1 #1–#4).
//
// The read-only dashboard + tile surface: list/read dashboards available in the actor's scope, and
// read a tile (compile + execute its spec on the read replica) + its freshness badge. Every route is
// gated by the REAL Authorization Contract (`requirePermission` / `requireAbac` from @wardenx/auth, M3)
// on the §4.6 keys M33 registers into M3's catalog (M33_CONTRIBUTED_PERMISSIONS). The `reportable_scope`
// ABAC predicate M33 owns (./abac-predicates) is composed on the scope-filtered reads (dashboard.read /
// tile.read) per the catalog's declared `abac` binding; the cross-tenant-safe scope envelope is sealed
// server-side inside the translator (D8), never read off the request.
//
// Every read runs through the injected M33ReadRouteService → `withReportSession` (the read-REPLICA,
// RLS-scoped, tiered-statement_timeout path, §8.1.2 / D3); HIPAA §164.312(b) read-audit is the standard
// M4 read-audit anchor on that path (the M34 read-route precedent — no per-handler audit call). Org/actor
// binding is ALWAYS server-side (request.context, never the body/query). Mirrors M34 routes/platform/tenants.ts.
import { requireAbac, requirePermission } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf } from "./actor";
import type { M33ReadRouteService } from "./read-service";
import {
  DashboardIdParamsSchema,
  DashboardListQuerySchema,
  TileKeyParamsSchema,
  TileReadQuery,
  parse,
} from "./reporting-typebox";

export interface DashboardTileRouteDeps {
  readonly service: M33ReadRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
// `reportable_scope` is the cross-cutting D8 read-scope predicate M33 owns (./abac-predicates).
const SCOPE = (key: string): PreHandler => requireAbac(key, "reportable_scope") as PreHandler;
// `dashboard_visibility` decides read on a saved view/dashboard (share-scope ladder, §4.7.2).
const VISIBILITY = (key: string): PreHandler => requireAbac(key, "dashboard_visibility") as PreHandler;

const DASH_LIST = P("report.dashboard.list");
const DASH_READ = P("report.dashboard.read");
const DASH_READ_VIS = VISIBILITY("report.dashboard.read");
const TILE_READ = P("report.tile.read");
const TILE_READ_SCOPE = SCOPE("report.tile.read");

/**
 * Register the §4.1 dashboard + tile READ routes (#1–#4). Mounted by the composition root behind the
 * same authenticate/security/error chain when a DB client is present (the M34 `mountTenantPlatformRoutes`
 * precedent).
 */
export function registerDashboardTileRoutes(app: FastifyInstance, deps: DashboardTileRouteDeps): void {
  const { service } = deps;

  // 1 — list dashboards available in the actor's org scope (cursor-paginated). §4.1.
  app.get(
    "/api/v1/reporting/dashboards",
    { preHandler: [DASH_LIST] },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(DashboardListQuerySchema, request.query);
      return service.listDashboards(actor, q.cursor, q.limit);
    },
  );

  // 2 — read one dashboard (share-scope visibility gate). §4.1/§4.7.2.
  app.get(
    "/api/v1/reporting/dashboards/:dashboardId",
    { preHandler: [DASH_READ, DASH_READ_VIS] },
    async (request) => {
      const actor = actorOf(request);
      const { dashboardId } = parse(DashboardIdParamsSchema, request.params);
      return service.getDashboard(actor, dashboardId);
    },
  );

  // 3 — read a tile: compile its spec → report_mv wrapper SELECT, scope-filter (D8), execute on the
  //     replica, return aggregate-only rows (D6 — never row-level PHI). §4.1/§4.2.
  app.get(
    "/api/v1/reporting/tiles/:tileKey",
    { preHandler: [TILE_READ, TILE_READ_SCOPE] },
    async (request) => {
      const actor = actorOf(request);
      const { tileKey } = parse(TileKeyParamsSchema, request.params);
      const q = parse(TileReadQuery, request.query);
      return service.readTile(actor, tileKey, {
        filters: q.filters,
        scopeOverride: q.scopeOverride,
        asOf: q.asOf,
      });
    },
  );

  // 4 — the tile freshness badge (`data_freshness_seconds` + the "Data as of" timestamp, §2.4). §4.1.
  app.get(
    "/api/v1/reporting/tiles/:tileKey/freshness",
    { preHandler: [TILE_READ, TILE_READ_SCOPE] },
    async (request) => {
      const actor = actorOf(request);
      const { tileKey } = parse(TileKeyParamsSchema, request.params);
      return service.getTileFreshness(actor, tileKey);
    },
  );
}

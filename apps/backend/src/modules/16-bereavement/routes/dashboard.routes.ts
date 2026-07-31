// apps/backend/src/modules/16-bereavement/routes/dashboard.routes.ts — M16 (§4.1) routes 30–31: the two
// dashboards.
//
// Route 30 is scoped to the CALLER's own caseload — the counselor id is taken from `request.context`, never
// from a query param, so there is no "show me someone else's caseload" shape to abuse. Route 31 is the
// full-tenant rollup and binds `org_scope_bereavement_oversight`.
//
// Both surfaces report COUNTS, never rates. A pre-divided CoP compliance number would strand M30's CMS
// small-N suppression and turn a 0/0 scope into a fabricated 0% nobody downstream could suppress — the same
// contract the §4.6 seams publish (`BereavementCopComplianceCounts`), so a supervisor and an HQRP report
// can never be shown two different bereavement-compliance rates for the same scope.
import type { FastifyInstance } from "fastify";
import { actorOf } from "./actor";
import { ABAC_DISCIPLINE_SELF, ABAC_OVERSIGHT, P } from "./guards";
import {
  CounselorDashboardQuerySchema,
  SupervisorDashboardQuerySchema,
  parseQuery,
} from "./m16-typebox";
import type { M16ReadService } from "./read-service";

export interface DashboardRouteDeps {
  readonly readService: M16ReadService;
}

export function registerBereavementDashboardRoutes(
  app: FastifyInstance,
  deps: DashboardRouteDeps,
): void {
  const { readService } = deps;

  // 30 — own caseload + what is due in the next N days.
  app.get(
    "/api/v1/bereavement/dashboard/counselor",
    {
      preHandler: [
        P("bereavement.dashboard.counselor"),
        ABAC_DISCIPLINE_SELF("bereavement.dashboard.counselor"),
      ],
      config: { auditRead: { resourceKind: "bereavement_plan", list: true } },
    },
    async (request) =>
      readService.counselorDashboard(
        actorOf(request),
        parseQuery(CounselorDashboardQuerySchema, request.query),
      ),
  );

  // 31 — full-tenant rollups, optionally narrowed to one CCN / location.
  app.get(
    "/api/v1/bereavement/dashboard/supervisor",
    {
      preHandler: [
        P("bereavement.dashboard.supervisor"),
        ABAC_OVERSIGHT("bereavement.dashboard.supervisor"),
      ],
      config: { auditRead: { resourceKind: "bereavement_plan", list: true } },
    },
    async (request) =>
      readService.supervisorDashboard(
        actorOf(request),
        parseQuery(SupervisorDashboardQuerySchema, request.query),
      ),
  );
}

// apps/backend/src/modules/27-cost-report/routes/statistics.routes.ts — M27 (§4.1 statistics surface).
//
// The S-3 statistical-data row (patient-days / wages / visits / bereavement aggregated from the M6/M8/M23
// seams). GET reads the current row (or null before the first refresh); POST .../refresh enqueues a
// statistics-refresh job (202) that re-pulls and overwrites version-checked. Read gates `cost_report.read`;
// refresh composes `cost_report_editor_for_provider` (§4.7) over the `:id`. M27 carries NO PHI (D18) — the
// statistics are aggregate counts only. Mutations carry `Idempotency-Key` (§4.1). Org/actor server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { CostReportIdParamsSchema, parse } from "./cost-report-typebox";
import { EDITOR_FOR_PROVIDER, P } from "./guards";
import type { M27ReadRouteService } from "./read-service";
import type { M27WriteRouteService } from "./write-service";

export interface StatisticsRouteDeps {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}

const READ = P("cost_report.read");
const EDIT = P("cost_report.edit");
const EDIT_ABAC = EDITOR_FOR_PROVIDER("cost_report.edit");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 statistics routes. */
export function registerStatisticsRoutes(app: FastifyInstance, deps: StatisticsRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /cost-reports/:id/statistics — read the S-3 statistical-data row (or null). §4.1.
  app.get("/api/v1/cost-reports/:id/statistics", { preHandler: [READ] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(CostReportIdParamsSchema, request.params);
    return readService.getStatistics(actor, id);
  });

  // POST /cost-reports/:id/statistics/refresh — re-pull from M6/M8/M23 seams, overwrite (202). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/statistics/refresh",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const res = await writeService.refreshStatistics(actor, id);
      return reply.code(202).send(res);
    },
  );
}

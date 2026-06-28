// apps/backend/src/modules/27-cost-report/routes/snapshots.routes.ts — M27 (§4.1 snapshot chain).
//
// The submit-time lockdown snapshot chain (§D10): list the chain (head + all priors; summary view — the
// content hash + reason + chain link, NO materialized payload) and read ONE snapshot's full
// `materialized_inputs` + `worksheet_snapshot`. The list gates `cost_report.read`; the full-detail read is
// the stricter `cost_report.read_snapshot_detail` (audit-read-logged — the one route that surfaces the
// materialized payloads). M27 carries NO PHI (D18). Both reads; no mutation, no Idempotency-Key. Org/actor
// binding is ALWAYS server-side.
import type { FastifyInstance } from "fastify";
import { actorOf } from "./actor";
import { P } from "./guards";
import type { M27ReadRouteService } from "./read-service";
import { CostReportIdParamsSchema, SnapshotParamsSchema, parse } from "./cost-report-typebox";

export interface SnapshotRouteDeps {
  readonly readService: M27ReadRouteService;
}

const READ = P("cost_report.read");
const READ_SNAPSHOT_DETAIL = P("cost_report.read_snapshot_detail");

/** Register the §4.1 snapshot routes. */
export function registerSnapshotRoutes(app: FastifyInstance, deps: SnapshotRouteDeps): void {
  const { readService } = deps;

  // GET /cost-reports/:id/snapshots — list the snapshot chain (head + priors; summary). §4.1.
  app.get("/api/v1/cost-reports/:id/snapshots", { preHandler: [READ] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(CostReportIdParamsSchema, request.params);
    return readService.listSnapshots(actor, id);
  });

  // GET /cost-reports/:id/snapshots/:sid — full materialized_inputs + worksheet_snapshot (audit-read). §4.1.
  app.get(
    "/api/v1/cost-reports/:id/snapshots/:sid",
    { preHandler: [READ_SNAPSHOT_DETAIL] },
    async (request) => {
      const actor = actorOf(request);
      const { id, sid } = parse(SnapshotParamsSchema, request.params);
      return readService.getSnapshot(actor, id, sid);
    },
  );
}

// apps/backend/src/modules/27-cost-report/routes/worksheets.routes.ts — M27 (§4.1 worksheet surface).
//
// The CMS-1984-14 worksheet read/replace/compute surface keyed on `(:id, :code)`. GET lazy-reads a
// worksheet (the write service returns the TypeBox-default body when no row exists yet); PUT replaces the
// `data` wholesale (the per-worksheet `resolveWorksheetSchema` validation runs in the write service against
// the `:code`, version-checked); POST .../compute enqueues a derived-worksheet recompute (B/C/D/E-1) onto
// the allocation queue (202). Reads gate `cost_report.read`; writes compose `cost_report_editor_for_provider`
// (§4.7) over the `:id`. Org/actor binding server-side; mutations carry `Idempotency-Key` (§4.1).
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { PutWorksheetBodySchema, WorksheetParamsSchema, parse } from "./cost-report-typebox";
import { EDITOR_FOR_PROVIDER, P } from "./guards";
import type { M27ReadRouteService, WorksheetCode } from "./read-service";
import type { M27WriteRouteService } from "./write-service";

export interface WorksheetRouteDeps {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}

const READ = P("cost_report.read");
const EDIT = P("cost_report.edit");
const EDIT_ABAC = EDITOR_FOR_PROVIDER("cost_report.edit");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 worksheet routes. */
export function registerWorksheetRoutes(app: FastifyInstance, deps: WorksheetRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /cost-reports/:id/worksheets/:code — read (lazy-creates the TypeBox-default if absent). §4.1.
  app.get("/api/v1/cost-reports/:id/worksheets/:code", { preHandler: [READ] }, async (request) => {
    const actor = actorOf(request);
    const { id, code } = parse(WorksheetParamsSchema, request.params);
    return readService.getWorksheet(actor, id, code as WorksheetCode);
  });

  // PUT /cost-reports/:id/worksheets/:code — replace `data` wholesale (TypeBox-per-code; version-checked). §4.1.
  app.put(
    "/api/v1/cost-reports/:id/worksheets/:code",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id, code } = parse(WorksheetParamsSchema, request.params);
      const body = parse(PutWorksheetBodySchema, request.body);
      const res = await writeService.putWorksheet(actor, id, code as WorksheetCode, {
        expectedVersion: body.expectedVersion,
        data: body.data,
      });
      return reply.code(200).send(res);
    },
  );

  // POST /cost-reports/:id/worksheets/:code/compute — enqueue a derived-worksheet recompute (202). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/worksheets/:code/compute",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id, code } = parse(WorksheetParamsSchema, request.params);
      const res = await writeService.computeWorksheet(actor, id, code as WorksheetCode);
      return reply.code(202).send(res);
    },
  );
}

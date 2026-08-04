// apps/backend/src/modules/27-cost-report/routes/imports.routes.ts — M27 (§4.1 import surface).
//
// The financial-input import history + pull triggers. Trial balance (Xero, §4.5) and wage data (Gusto) each
// expose: list history, trigger an immediate adapter pull (enqueues the pull job → 202 job id), and a manual
// CSV/JSON upload (the row is discriminated `source='manual_csv'` / `source='manual'`; the pre-normalized
// rows are parsed at the edge). Lists gate `cost_report.read`; triggers + manual uploads compose
// `cost_report_editor_for_provider` (§4.7) over the `:id`. The Xero/Gusto payloads are envelope-encrypted at
// rest by the worker (financial PII, not PHI). Mutations carry `Idempotency-Key` (§4.1). Org/actor server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  CostReportIdParamsSchema,
  ManualTrialBalanceBodySchema,
  ManualWageDataBodySchema,
  parse,
} from "./cost-report-typebox";
import { EDITOR_FOR_PROVIDER, P } from "./guards";
import type { M27ReadRouteService } from "./read-service";
import type { M27WriteRouteService } from "./write-service";

export interface ImportRouteDeps {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}

const READ = P("cost_report.read");
const EDIT = P("cost_report.edit");
const EDIT_ABAC = EDITOR_FOR_PROVIDER("cost_report.edit");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 import routes (trial balance + wage data). */
export function registerImportRoutes(app: FastifyInstance, deps: ImportRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /cost-reports/:id/imports/trial-balance — list trial-balance import history. §4.1.
  app.get(
    "/api/v1/cost-reports/:id/imports/trial-balance",
    { preHandler: [READ] },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      return readService.listTrialBalanceImports(actor, id);
    },
  );

  // POST /cost-reports/:id/imports/trial-balance — trigger an immediate Xero pull (202 job id). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/imports/trial-balance",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const res = await writeService.triggerTrialBalancePull(actor, id);
      return reply.code(202).send(res);
    },
  );

  // POST /cost-reports/:id/imports/trial-balance/manual — manual CSV upload (source='manual_csv'). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/imports/trial-balance/manual",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(ManualTrialBalanceBodySchema, request.body);
      const res = await writeService.manualTrialBalance(actor, id, {
        normalizedAccounts: body.normalizedAccounts,
      });
      return reply.code(201).send(res);
    },
  );

  // GET /cost-reports/:id/imports/wage-data — list wage-data import history. §4.1.
  app.get("/api/v1/cost-reports/:id/imports/wage-data", { preHandler: [READ] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(CostReportIdParamsSchema, request.params);
    return readService.listWageDataImports(actor, id);
  });

  // POST /cost-reports/:id/imports/wage-data — trigger an immediate Gusto pull (202 job id). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/imports/wage-data",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const res = await writeService.triggerWageDataPull(actor, id);
      return reply.code(202).send(res);
    },
  );

  // POST /cost-reports/:id/imports/wage-data/manual — manual upload (source='manual'). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/imports/wage-data/manual",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(ManualWageDataBodySchema, request.body);
      const res = await writeService.manualWageData(actor, id, {
        normalizedWageRows: body.normalizedWageRows,
      });
      return reply.code(201).send(res);
    },
  );
}

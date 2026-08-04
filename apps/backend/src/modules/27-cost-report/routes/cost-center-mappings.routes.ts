// apps/backend/src/modules/27-cost-report/routes/cost-center-mappings.routes.ts — M27 (§4.1 mappings).
//
// The GL-account → CMS-cost-center mapping surface: list the active mappings for the report's FY/provider,
// PREVIEW a proposed change (no write — returns the impact: which accounts move, which totals shift), APPLY
// a change (version-checked, emits `m27.cost_center_mapping.applied`), and RESET the FY's mappings to the
// platform default (tenant overrides optionally preserved). List gates `cost_report.read`; preview gates the
// `cost_report.edit` editor predicate (it is a no-write what-if so carries no Idempotency-Key); apply/reset
// gate the higher-bar `cost_report.edit_mappings` (mappings affect every future report for the FY) + the
// editor predicate (§4.7) over the `:id`. Mutations carry `Idempotency-Key` (§4.1). Org/actor server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  ApplyMappingBodySchema,
  CostReportIdParamsSchema,
  PreviewMappingBodySchema,
  ResetMappingBodySchema,
  parse,
} from "./cost-report-typebox";
import { EDITOR_FOR_PROVIDER, P } from "./guards";
import type { M27ReadRouteService } from "./read-service";
import type { M27WriteRouteService } from "./write-service";

export interface CostCenterMappingRouteDeps {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}

const READ = P("cost_report.read");
const EDIT = P("cost_report.edit");
const EDIT_ABAC = EDITOR_FOR_PROVIDER("cost_report.edit");
const EDIT_MAPPINGS = P("cost_report.edit_mappings");
const EDIT_MAPPINGS_ABAC = EDITOR_FOR_PROVIDER("cost_report.edit_mappings");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 cost-center-mapping routes. */
export function registerCostCenterMappingRoutes(
  app: FastifyInstance,
  deps: CostCenterMappingRouteDeps,
): void {
  const { readService, writeService } = deps;

  // GET /cost-reports/:id/cost-center-mappings — list active mappings for the FY/provider. §4.1.
  app.get(
    "/api/v1/cost-reports/:id/cost-center-mappings",
    { preHandler: [READ] },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      return readService.listCostCenterMappings(actor, id);
    },
  );

  // POST /cost-reports/:id/cost-center-mappings/preview — impact preview (NO write). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/cost-center-mappings/preview",
    { preHandler: [EDIT, EDIT_ABAC] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(PreviewMappingBodySchema, request.body);
      const res = await writeService.previewCostCenterMapping(actor, id, { changes: body.changes });
      return reply.code(200).send(res);
    },
  );

  // POST /cost-reports/:id/cost-center-mappings/apply — apply a mapping change (version-checked). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/cost-center-mappings/apply",
    { preHandler: [EDIT_MAPPINGS, EDIT_MAPPINGS_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(ApplyMappingBodySchema, request.body);
      const res = await writeService.applyCostCenterMapping(actor, id, {
        changes: body.changes,
        mappingSource: body.mappingSource,
      });
      return reply.code(200).send(res);
    },
  );

  // POST /cost-reports/:id/cost-center-mappings/reset-to-platform-default — reset the FY's mappings. §4.1.
  app.post(
    "/api/v1/cost-reports/:id/cost-center-mappings/reset-to-platform-default",
    { preHandler: [EDIT_MAPPINGS, EDIT_MAPPINGS_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(ResetMappingBodySchema, request.body);
      const res = await writeService.resetCostCenterMapping(actor, id, {
        keepTenantOverrides: body.keepTenantOverrides,
      });
      return reply.code(200).send(res);
    },
  );
}

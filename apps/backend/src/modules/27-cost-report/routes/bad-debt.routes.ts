// apps/backend/src/modules/27-cost-report/routes/bad-debt.routes.ts — M27 (§4.1 bad-debt surface).
//
// The Medicare bad-debt register (deductible / coinsurance amounts, integer cents per D8): list, add
// (parent must be draft/populating), update, and soft-delete (audit-logged). List gates `cost_report.read`;
// every mutation gates the higher-bar `cost_report.edit_bad_debt` + the editor predicate (§4.7) over the
// `:id`. The acting principal stamped onto `added_by_membership_id` comes from the actor, NEVER the body.
// Mutations carry `Idempotency-Key` (§4.1). M27 carries NO PHI (D18). Org/actor binding server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  AddBadDebtBodySchema,
  BadDebtRecordParamsSchema,
  CostReportIdParamsSchema,
  UpdateBadDebtBodySchema,
  parse,
} from "./cost-report-typebox";
import { EDITOR_FOR_PROVIDER, P } from "./guards";
import type { M27ReadRouteService } from "./read-service";
import type { M27WriteRouteService } from "./write-service";

export interface BadDebtRouteDeps {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}

const READ = P("cost_report.read");
const EDIT_BAD_DEBT = P("cost_report.edit_bad_debt");
const EDIT_BAD_DEBT_ABAC = EDITOR_FOR_PROVIDER("cost_report.edit_bad_debt");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 bad-debt routes. */
export function registerBadDebtRoutes(app: FastifyInstance, deps: BadDebtRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /cost-reports/:id/bad-debt — list bad-debt records. §4.1.
  app.get("/api/v1/cost-reports/:id/bad-debt", { preHandler: [READ] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(CostReportIdParamsSchema, request.params);
    return readService.listBadDebt(actor, id);
  });

  // POST /cost-reports/:id/bad-debt — add a record (parent state in draft/populating). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/bad-debt",
    { preHandler: [EDIT_BAD_DEBT, EDIT_BAD_DEBT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(AddBadDebtBodySchema, request.body);
      const res = await writeService.addBadDebt(actor, id, {
        periodLabel: body.periodLabel,
        debtKind: body.debtKind,
        amountCents: body.amountCents,
        collectionEffortsDocumented: body.collectionEffortsDocumented,
        supportingDocumentIds: body.supportingDocumentIds,
      });
      return reply.code(201).send(res);
    },
  );

  // PATCH /cost-reports/:id/bad-debt/:recordId — update a record (state-guarded). §4.1.
  app.patch(
    "/api/v1/cost-reports/:id/bad-debt/:recordId",
    { preHandler: [EDIT_BAD_DEBT, EDIT_BAD_DEBT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id, recordId } = parse(BadDebtRecordParamsSchema, request.params);
      const body = parse(UpdateBadDebtBodySchema, request.body);
      const res = await writeService.updateBadDebt(actor, id, recordId, {
        periodLabel: body.periodLabel,
        debtKind: body.debtKind,
        amountCents: body.amountCents,
        collectionEffortsDocumented: body.collectionEffortsDocumented,
        supportingDocumentIds: body.supportingDocumentIds,
      });
      return reply.code(200).send(res);
    },
  );

  // DELETE /cost-reports/:id/bad-debt/:recordId — soft-delete a record (audit-logged). §4.1.
  app.delete(
    "/api/v1/cost-reports/:id/bad-debt/:recordId",
    { preHandler: [EDIT_BAD_DEBT, EDIT_BAD_DEBT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id, recordId } = parse(BadDebtRecordParamsSchema, request.params);
      const res = await writeService.deleteBadDebt(actor, id, recordId);
      return reply.code(200).send(res);
    },
  );
}

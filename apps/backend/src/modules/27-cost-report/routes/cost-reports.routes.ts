// apps/backend/src/modules/27-cost-report/routes/cost-reports.routes.ts — M27 (§4.1 cost-report root).
//
// The cost-report lifecycle root: create / list / detail / patch-metadata, the async input-refresh +
// step-down allocation enqueue (202), and the state-machine ladder return-to-draft → approve-for-submit →
// submit / submit-past-deadline → reopen. The reads gate on `cost_report.read` (the §4.6 `inOrg` default —
// aggregate, no PHI per D18); the edit surface composes `cost_report_editor_for_provider` (§4.7) over the
// `:id`; the approval/submit/reopen ladder composes `cost_report_approver_for_provider` PLUS the §D14
// `requireStepUp` assertion (a filing/integrity action). Org/actor/membership binding is ALWAYS server-side
// (`request.context` via `actorOf`/`writeActorOf`), NEVER read off the body — the submit attestation body
// names the attesting membership the actor swears to, but the write service stamps the acting principal
// from the actor and re-checks the two-person control. Every mutating route carries `Idempotency-Key`
// (§4.1; the M1 `applyIdempotency` middleware does the 24h replay caching — this guard enforces PRESENCE).
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  APPROVER_FOR_PROVIDER,
  EDITOR_FOR_PROVIDER,
  EDITOR_FOR_PROVIDER_CREATE,
  P,
  STEP_UP,
} from "./guards";
import type { M27ReadRouteService } from "./read-service";
import type { M27WriteRouteService } from "./write-service";
import {
  ApproveForSubmitBodySchema,
  CostReportIdParamsSchema,
  CostReportListQuerySchema,
  CreateCostReportBodySchema,
  PatchCostReportBodySchema,
  ReopenBodySchema,
  SubmitBodySchema,
  SubmitPastDeadlineBodySchema,
  parse,
} from "./cost-report-typebox";

export interface CostReportRouteDeps {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}

const READ = P("cost_report.read");
const CREATE = P("cost_report.create");
const CREATE_ABAC = EDITOR_FOR_PROVIDER_CREATE("cost_report.create");
const EDIT = P("cost_report.edit");
const EDIT_ABAC = EDITOR_FOR_PROVIDER("cost_report.edit");
const APPROVE = P("cost_report.approve_for_submit");
const APPROVE_ABAC = APPROVER_FOR_PROVIDER("cost_report.approve_for_submit");
const APPROVE_STEPUP = STEP_UP("cost_report.approve_for_submit");
const SUBMIT = P("cost_report.submit");
const SUBMIT_ABAC = APPROVER_FOR_PROVIDER("cost_report.submit");
const SUBMIT_STEPUP = STEP_UP("cost_report.submit");
const SUBMIT_PAST = P("cost_report.submit_past_deadline");
const SUBMIT_PAST_ABAC = APPROVER_FOR_PROVIDER("cost_report.submit_past_deadline");
const SUBMIT_PAST_STEPUP = STEP_UP("cost_report.submit_past_deadline");
const REOPEN = P("cost_report.reopen_submitted");
const REOPEN_ABAC = APPROVER_FOR_PROVIDER("cost_report.reopen_submitted");
const REOPEN_STEPUP = STEP_UP("cost_report.reopen_submitted");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 cost-report root + lifecycle routes. */
export function registerCostReportRoutes(app: FastifyInstance, deps: CostReportRouteDeps): void {
  const { readService, writeService } = deps;

  // POST /cost-reports — create a report for a (ProviderEntity, FYE); auto-opens a compliance window. §4.1.
  app.post(
    "/api/v1/cost-reports",
    { preHandler: [CREATE, CREATE_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateCostReportBodySchema, request.body);
      const res = await writeService.createCostReport(actor, {
        providerEntityId: body.providerEntityId,
        fiscalYearStartDate: body.fiscalYearStartDate,
        fiscalYearEndDate: body.fiscalYearEndDate,
        wageSource: body.wageSource,
      });
      return reply.code(201).send(res);
    },
  );

  // GET /cost-reports — list (filter by providerEntityId / fiscalYear / state; cursor-paginated). §4.1.
  app.get("/api/v1/cost-reports", { preHandler: [READ] }, async (request) => {
    const actor = actorOf(request);
    const q = parse(CostReportListQuerySchema, request.query);
    return readService.listCostReports(
      actor,
      { providerEntityId: q.providerEntityId, fiscalYear: q.fiscalYear, state: q.state },
      q.cursor,
      q.limit,
    );
  });

  // GET /cost-reports/:id — detail (snapshot summary + latest validation + latest submission + window). §4.1.
  app.get("/api/v1/cost-reports/:id", { preHandler: [READ] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(CostReportIdParamsSchema, request.params);
    return readService.getCostReport(actor, id);
  });

  // PATCH /cost-reports/:id — editable metadata (bad-debt-claimed, wage source); version-checked. §4.1.
  app.patch(
    "/api/v1/cost-reports/:id",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(PatchCostReportBodySchema, request.body);
      const res = await writeService.patchCostReport(actor, id, {
        expectedVersion: body.expectedVersion,
        badDebtClaimed: body.badDebtClaimed,
        wageSource: body.wageSource,
      });
      return reply.code(200).send(res);
    },
  );

  // POST /cost-reports/:id/refresh-inputs — enqueue trial-balance + wage + statistics pulls (202). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/refresh-inputs",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const res = await writeService.refreshInputs(actor, id);
      return reply.code(202).send(res);
    },
  );

  // POST /cost-reports/:id/allocate — enqueue the step-down + apportionment recompute (B/C/D/E-1) (202). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/allocate",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const res = await writeService.allocate(actor, id);
      return reply.code(202).send(res);
    },
  );

  // POST /cost-reports/:id/return-to-draft — ready_for_review → populating. §4.1.
  app.post(
    "/api/v1/cost-reports/:id/return-to-draft",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const res = await writeService.returnToDraft(actor, id);
      return reply.code(200).send(res);
    },
  );

  // POST /cost-reports/:id/approve-for-submit — ready_for_review → approved_for_submit (approver + step-up). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/approve-for-submit",
    { preHandler: [APPROVE, APPROVE_ABAC, APPROVE_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(ApproveForSubmitBodySchema, request.body);
      const res = await writeService.approveForSubmit(actor, id, { validationId: body.validationId });
      return reply.code(200).send(res);
    },
  );

  // POST /cost-reports/:id/submit — approved_for_submit → submitted; builds snapshot, enqueues ECR. §4.1.
  app.post(
    "/api/v1/cost-reports/:id/submit",
    { preHandler: [SUBMIT, SUBMIT_ABAC, SUBMIT_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(SubmitBodySchema, request.body);
      const res = await writeService.submit(actor, id, {
        attestedByMembershipId: body.attestedByMembershipId,
        attestedAt: body.attestedAt,
        approvedByMembershipId: body.approvedByMembershipId,
      });
      return reply.code(200).send(res);
    },
  );

  // POST /cost-reports/:id/submit-past-deadline — submit bypassing the past-deadline block (warn-severity). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/submit-past-deadline",
    { preHandler: [SUBMIT_PAST, SUBMIT_PAST_ABAC, SUBMIT_PAST_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(SubmitPastDeadlineBodySchema, request.body);
      const res = await writeService.submitPastDeadline(actor, id, {
        attestedByMembershipId: body.attestedByMembershipId,
        attestedAt: body.attestedAt,
        approvedByMembershipId: body.approvedByMembershipId,
        reason: body.reason,
      });
      return reply.code(200).send(res);
    },
  );

  // POST /cost-reports/:id/reopen — reopen a submitted/accepted/rejected report (approver + step-up + reason). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/reopen",
    { preHandler: [REOPEN, REOPEN_ABAC, REOPEN_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(ReopenBodySchema, request.body);
      const res = await writeService.reopen(actor, id, {
        reason: body.reason,
        reasonCategory: body.reasonCategory,
      });
      return reply.code(200).send(res);
    },
  );
}

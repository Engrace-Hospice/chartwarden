// apps/backend/src/modules/27-cost-report/routes/validations.routes.ts — M27 (§4.1 validation surface).
//
// The pre-submission validation plane: list validation runs (most recent first), read a run with its
// per-rule results + override status, ENQUEUE a `validation-run` job (202; state → validating), and
// OVERRIDE a specific failing rule result with a reason. The §D9 invariant is honored downstream (each run
// is a separate row carrying its `rule_set_version`; overrides link to the result, not the rule). Reads gate
// `cost_report.read`; enqueue composes `cost_report_editor_for_provider` (§4.7); the override is the elevated
// path — `cost_report.override_validation` + the approver predicate + the §D14 `requireStepUp` assertion.
// Mutations carry `Idempotency-Key` (§4.1). Org/actor/membership binding is ALWAYS server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { APPROVER_FOR_PROVIDER, EDITOR_FOR_PROVIDER, P, STEP_UP } from "./guards";
import type { M27ReadRouteService } from "./read-service";
import type { M27WriteRouteService } from "./write-service";
import {
  CostReportIdParamsSchema,
  OverrideValidationResultBodySchema,
  ValidationParamsSchema,
  parse,
} from "./cost-report-typebox";

export interface ValidationRouteDeps {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}

const READ = P("cost_report.read");
const EDIT = P("cost_report.edit");
const EDIT_ABAC = EDITOR_FOR_PROVIDER("cost_report.edit");
const OVERRIDE = P("cost_report.override_validation");
const OVERRIDE_ABAC = APPROVER_FOR_PROVIDER("cost_report.override_validation");
const OVERRIDE_STEPUP = STEP_UP("cost_report.override_validation");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 validation routes. */
export function registerValidationRoutes(app: FastifyInstance, deps: ValidationRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /cost-reports/:id/validations — list validation runs (most recent first). §4.1.
  app.get("/api/v1/cost-reports/:id/validations", { preHandler: [READ] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(CostReportIdParamsSchema, request.params);
    return readService.listValidations(actor, id);
  });

  // GET /cost-reports/:id/validations/:vid — read a run with per-rule results + override status. §4.1.
  app.get(
    "/api/v1/cost-reports/:id/validations/:vid",
    { preHandler: [READ] },
    async (request) => {
      const actor = actorOf(request);
      const { id, vid } = parse(ValidationParamsSchema, request.params);
      return readService.getValidation(actor, id, vid);
    },
  );

  // POST /cost-reports/:id/validate — enqueue a validation run (202; state → validating). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/validate",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const res = await writeService.enqueueValidation(actor, id);
      return reply.code(202).send(res);
    },
  );

  // POST /cost-reports/:id/validations/:vid/overrides — override a failing rule result (approver + step-up). §4.1.
  app.post(
    "/api/v1/cost-reports/:id/validations/:vid/overrides",
    { preHandler: [OVERRIDE, OVERRIDE_ABAC, OVERRIDE_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id, vid } = parse(ValidationParamsSchema, request.params);
      const body = parse(OverrideValidationResultBodySchema, request.body);
      const res = await writeService.overrideValidationResult(actor, id, vid, {
        validationResultId: body.validationResultId,
        reason: body.reason,
      });
      return reply.code(201).send(res);
    },
  );
}

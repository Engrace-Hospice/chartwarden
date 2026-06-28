// apps/backend/src/modules/23-billing-medicare/routes/validation.routes.ts — M23 (§4.1 validation plane).
//
// The pre-submission validation surface: list a claim's validation runs (most recent first), read a single
// run with its per-rule results + override status, trigger a `manual_re_run` validation (202; the write
// service drives the pure claim machine + emits `m23.claim.validation_started`), and OVERRIDE a specific
// failing rule result (the elevated path). Each run is its own row carrying the rule-set version (§D9); an
// override links to the result, never the rule. Reads gate `billing.validation.read_run` + the claim-caseload
// ABAC; the trigger gates `billing.validation.run` + claim-caseload; the override gates
// `billing.validation.override` + the §4.7 `override_role_eligible` predicate + the §D14 step-up assertion +
// the §D13 AI-block. Mutations carry `Idempotency-Key` (§4.1). Org/actor binding is ALWAYS server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { CLAIM_CASELOAD, OVERRIDE_ELIGIBLE, P, STEP_UP } from "./guards";
import type { M23ReadRouteService } from "./read-service";
import type { M23WriteRouteService } from "./write-service";
import {
  ClaimIdParamsSchema,
  OverrideParamsSchema,
  OverrideValidationResultBodySchema,
  ValidationRunParamsSchema,
  parse,
} from "./billing-typebox";

export interface ValidationRouteDeps {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
}

const READ_RUN = P("billing.validation.read_run");
const READ_RUN_ABAC = CLAIM_CASELOAD("billing.validation.read_run");
const RUN = P("billing.validation.run");
const RUN_ABAC = CLAIM_CASELOAD("billing.validation.run");
const OVERRIDE = P("billing.validation.override");
const OVERRIDE_ABAC = OVERRIDE_ELIGIBLE("billing.validation.override");
const OVERRIDE_STEPUP = STEP_UP("billing.validation.override");
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 validation-run + override routes. */
export function registerValidationRoutes(app: FastifyInstance, deps: ValidationRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /claims/:id/validation-runs — list validation runs (most recent first). §4.1 #14.
  app.get(
    "/api/v1/claims/:id/validation-runs",
    { preHandler: [READ_RUN, READ_RUN_ABAC] },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      return { claimId: id, runs: await readService.listValidationRuns(actor, id) };
    },
  );

  // GET /claims/:id/validation-runs/:runId — single run with per-rule results + override status. §4.1 #15.
  app.get(
    "/api/v1/claims/:id/validation-runs/:runId",
    { preHandler: [READ_RUN, READ_RUN_ABAC] },
    async (request) => {
      const actor = actorOf(request);
      const { id, runId } = parse(ValidationRunParamsSchema, request.params);
      return readService.getValidationRun(actor, id, runId);
    },
  );

  // POST /claims/:id/validate — trigger a `manual_re_run` validation (202; state → validating). §4.1 #6.
  app.post(
    "/api/v1/claims/:id/validate",
    { preHandler: [RUN, RUN_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      const res = await writeService.validateClaim(actor, id);
      return reply.code(202).send(res);
    },
  );

  // POST /claims/:id/validation-runs/:runId/results/:resultId/override — override a failed result. §4.1 #16.
  // The elevated path: approver-role ABAC (`override_role_eligible`) + step-up + the AI-block. Returns 201.
  app.post(
    "/api/v1/claims/:id/validation-runs/:runId/results/:resultId/override",
    { preHandler: [OVERRIDE, OVERRIDE_ABAC, OVERRIDE_STEPUP, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id, resultId } = parse(OverrideParamsSchema, request.params);
      const body = parse(OverrideValidationResultBodySchema, request.body);
      const res = await writeService.overrideValidationResult(actor, id, {
        validationResultId: resultId,
        reason: body.reason,
        overrideRole: body.overrideRole,
      });
      return reply.code(201).send(res);
    },
  );
}

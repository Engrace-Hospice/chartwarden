// apps/backend/src/modules/27-cost-report/routes/validation-rules.routes.ts — M27 (§4.1 rule library).
//
// The tenant validation-rule library (NOT under `/cost-reports`; mounted at `/cost-report-validation-rules`):
// list the rules (platform-defaults + tenant-extensions), add a tenant rule (cannot create with
// `regulatoryRequired=true` — enforced in the service), update a tenant rule (platform-default rules are
// immutable from the tenant surface), and tenant-disable a non-regulatory rule. The read gates
// `cost_report.read_rules`; every mutation gates `cost_report.manage_rules` (the §4.6 `inOrg` default — the
// library is org-scoped, not provider-scoped, so no provider ABAC predicate is layered). Mutations carry
// `Idempotency-Key` (§4.1). M27 carries NO PHI (D18). Org/actor binding is ALWAYS server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import type { M27ReadRouteService } from "./read-service";
import type { M27WriteRouteService } from "./write-service";
import {
  CreateValidationRuleBodySchema,
  RuleIdParamsSchema,
  UpdateValidationRuleBodySchema,
  parse,
} from "./cost-report-typebox";

export interface ValidationRuleRouteDeps {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}

const READ_RULES = P("cost_report.read_rules");
const MANAGE_RULES = P("cost_report.manage_rules");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 validation-rule-library routes. */
export function registerValidationRuleRoutes(
  app: FastifyInstance,
  deps: ValidationRuleRouteDeps,
): void {
  const { readService, writeService } = deps;

  // GET /cost-report-validation-rules — list rules (platform-defaults + tenant-extensions). §4.1.
  app.get("/api/v1/cost-report-validation-rules", { preHandler: [READ_RULES] }, async (request) => {
    const actor = actorOf(request);
    return readService.listValidationRules(actor);
  });

  // POST /cost-report-validation-rules — add a tenant rule (cannot be regulatoryRequired). §4.1.
  app.post(
    "/api/v1/cost-report-validation-rules",
    { preHandler: [MANAGE_RULES, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateValidationRuleBodySchema, request.body);
      const res = await writeService.createValidationRule(actor, {
        ruleCode: body.ruleCode,
        category: body.category,
        description: body.description,
        severity: body.severity,
        macJurisdictionScope: body.macJurisdictionScope,
        predicateSpec: body.predicateSpec,
      });
      return reply.code(201).send(res);
    },
  );

  // PATCH /cost-report-validation-rules/:id — update a tenant rule (platform-defaults immutable). §4.1.
  app.patch(
    "/api/v1/cost-report-validation-rules/:id",
    { preHandler: [MANAGE_RULES, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(RuleIdParamsSchema, request.params);
      const body = parse(UpdateValidationRuleBodySchema, request.body);
      const res = await writeService.updateValidationRule(actor, id, {
        description: body.description,
        severity: body.severity,
        macJurisdictionScope: body.macJurisdictionScope,
        predicateSpec: body.predicateSpec,
      });
      return reply.code(200).send(res);
    },
  );

  // POST /cost-report-validation-rules/:id/disable — tenant-disable a non-regulatory rule. §4.1.
  app.post(
    "/api/v1/cost-report-validation-rules/:id/disable",
    { preHandler: [MANAGE_RULES, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(RuleIdParamsSchema, request.params);
      const res = await writeService.disableValidationRule(actor, id);
      return reply.code(200).send(res);
    },
  );
}

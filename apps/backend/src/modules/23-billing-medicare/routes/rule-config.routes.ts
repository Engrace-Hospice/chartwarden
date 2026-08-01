// apps/backend/src/modules/23-billing-medicare/routes/rule-config.routes.ts — M23 (§4.1 rule-config overlay).
//
// The tenant validation-rule overlay library: list the overlay rows (the platform §11.A registry snapshot +
// the tenant overlays), create a tenant CUSTOM rule (predicate DSL), PATCH an overlay (disable / re-severity
// / re-parameterize a platform rule), and DELETE an overlay (revert to the platform default). Reads gate
// `billing.rule_config.read` (the `inOrg` default — the library is org-scoped, not provider-scoped). Every
// mutation gates `billing.rule_config.edit` + the §4.7 `regulatory_required_rule_protected` predicate (D5:
// a `regulatoryRequired` rule cannot be overlay-edited / disabled / deleted) + the §D13 AI-block. The PATCH
// and DELETE carry the §2.5 `If-Match` optimistic-concurrency header (412 on stale); every mutation carries
// `Idempotency-Key` (§4.1). Org/actor/membership binding is ALWAYS server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { parseIfMatch, requireIdempotencyKey, requireIfMatch } from "./concurrency";
import { P, RULE_PROTECTED } from "./guards";
import type { M23ReadRouteService } from "./read-service";
import type { M23WriteRouteService } from "./write-service";
import {
  CreateRuleConfigBodySchema,
  RuleConfigIdParamsSchema,
  RuleConfigListQuerySchema,
  UpdateRuleConfigBodySchema,
  parse,
} from "./billing-typebox";

export interface RuleConfigRouteDeps {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
}

const READ = P("billing.rule_config.read");
const EDIT = P("billing.rule_config.edit");
const EDIT_ABAC = RULE_PROTECTED("billing.rule_config.edit");
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const IF_MATCH = requireIfMatch();

/** Register the §4.1 rule-config overlay routes. */
export function registerRuleConfigRoutes(app: FastifyInstance, deps: RuleConfigRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /billing/rule-configs — list overlay rows (platform snapshot + tenant overlays). §4.1 #18.
  app.get(
    "/api/v1/billing/rule-configs",
    {
      preHandler: [READ],
      config: {
        auditRead: { none: "validation rule configuration — tenant policy, no patient data" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(RuleConfigListQuerySchema, request.query);
      return readService.listRuleConfigs(
        actor,
        { enabled: q.enabled, isCustom: q.isCustom },
        q.cursor,
        q.limit,
      );
    },
  );

  // GET /billing/rule-configs/:id — read a single overlay row. §4.1.
  app.get(
    "/api/v1/billing/rule-configs/:id",
    {
      preHandler: [READ],
      config: {
        auditRead: { none: "one validation rule's configuration — tenant policy, no patient data" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(RuleConfigIdParamsSchema, request.params);
      return readService.getRuleConfig(actor, id);
    },
  );

  // POST /billing/rule-configs/custom — create a tenant custom rule (regulatory-required forbidden). §4.1 #20.
  app.post(
    "/api/v1/billing/rule-configs/custom",
    { preHandler: [EDIT, EDIT_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateRuleConfigBodySchema, request.body);
      const res = await writeService.createRuleConfig(actor, {
        ruleKey: body.ruleKey,
        isCustom: true,
        enabled: body.enabled,
        severity: body.severity,
        overrideRoleRequired: body.overrideRoleRequired,
        parameters: body.parameters,
        predicateDsl: body.predicateDsl,
        setReason: body.setReason,
        ruleVersion: body.ruleVersion,
      });
      return reply.code(201).send(res);
    },
  );

  // PATCH /billing/rule-configs/:id — overlay edit (disable / re-severity / re-parameterize). §4.1 #19.
  app.patch(
    "/api/v1/billing/rule-configs/:id",
    { preHandler: [EDIT, EDIT_ABAC, NO_AI, IF_MATCH, IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(RuleConfigIdParamsSchema, request.params);
      const body = parse(UpdateRuleConfigBodySchema, request.body);
      const expectedVersion = parseIfMatch(request);
      return writeService.updateRuleConfig(actor, id, {
        expectedVersion,
        enabled: body.enabled,
        severity: body.severity,
        overrideRoleRequired: body.overrideRoleRequired,
        parameters: body.parameters,
        predicateDsl: body.predicateDsl,
        setReason: body.setReason,
      });
    },
  );

  // DELETE /billing/rule-configs/:id — revert the overlay to the platform default. §4.1 #21.
  app.delete(
    "/api/v1/billing/rule-configs/:id",
    { preHandler: [EDIT, EDIT_ABAC, NO_AI, IF_MATCH, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(RuleConfigIdParamsSchema, request.params);
      const expectedVersion = parseIfMatch(request);
      await writeService.deleteRuleConfig(actor, id, { expectedVersion });
      return reply.code(204).send();
    },
  );
}

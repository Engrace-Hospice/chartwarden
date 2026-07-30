// apps/backend/src/modules/24-billing-medicaid/routes/rule-config.routes.ts — M24 (§4.1) the validation
// rule-config surface (routes 18–21). The edit/delete routes compose the §4.8
// `regulatory_required_rule_protected_medicaid` ABAC over `:ruleKey` (a regulatory-required rule cannot be
// disabled/removed — the three-layer guard per §8.3/D5), the §8.6 AI reject, + the §F08 Idempotency-Key.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { ABAC_RULE, P } from "./guards";
import type { M24ReadService } from "./read-service";
import type { M24WriteService } from "./write-service";

export interface RuleConfigRouteDeps {
  readonly readService: M24ReadService;
  readonly writeService: M24WriteService;
}

const AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const pParam = (request: { params: unknown }, key: string): string =>
  (request.params as Record<string, string>)[key] ?? "";

export function registerRuleConfigRoutes(app: FastifyInstance, deps: RuleConfigRouteDeps): void {
  const { readService, writeService } = deps;

  // 18 — read overlay + platform registry
  app.get("/api/v1/medicaid-rule-config", { preHandler: [P("medicaid.rule_config.read")] }, async (request, reply) =>
    reply.send(await readService.listRuleConfig(actorOf(request))),
  );

  // 19 — edit tenant overlay on non-regulatory rules
  app.patch(
    "/api/v1/medicaid-rule-config/:ruleKey",
    { preHandler: [P("medicaid.rule_config.edit"), ABAC_RULE("medicaid.rule_config.edit", "regulatory_required_rule_protected_medicaid"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = (request.body ?? {}) as { enabled?: boolean; parametersOverlay?: unknown };
      await writeService.editRuleConfig(writeActorOf(request), pParam(request, "ruleKey"), {
        expectedVersion: ifMatchVersion(request),
        enabled: body.enabled,
        parametersOverlay: body.parametersOverlay,
      });
      return reply.code(204).send();
    },
  );

  // 20 — create custom rule via DSL
  app.post(
    "/api/v1/medicaid-rule-config/custom",
    { preHandler: [P("medicaid.rule_config.edit"), AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = request.body as { ruleKey: string; customPredicateDsl: unknown; customSeverity: string; customOverrideRole?: string };
      return reply.code(201).send(await writeService.createCustomRule(writeActorOf(request), body));
    },
  );

  // 21 — delete custom rule (non-regulatory only)
  app.delete(
    "/api/v1/medicaid-rule-config/:ruleKey",
    { preHandler: [P("medicaid.rule_config.edit"), ABAC_RULE("medicaid.rule_config.edit", "regulatory_required_rule_protected_medicaid"), AI, IDEMPOTENT] },
    async (request, reply) => {
      await writeService.deleteCustomRule(writeActorOf(request), pParam(request, "ruleKey"), ifMatchVersion(request));
      return reply.code(204).send();
    },
  );
}

// apps/backend/src/modules/24-billing-medicaid/routes/rule-config.routes.ts — M24 (§4.1) the validation
// rule-config surface (routes 18–21). The edit/delete routes compose the §4.8
// `regulatory_required_rule_protected_medicaid` ABAC over `:ruleKey` (a regulatory-required rule cannot be
// disabled/removed — the three-layer guard per §8.3/D5), the §8.6 AI reject, + the §F08 Idempotency-Key.
import { rejectAiActor, requireIdempotencyKey } from "@chartwarden/shared/route-kit";
import type { FastifyInstance } from "fastify";
import { m24ActorOf } from "./actor";
import { ABAC_RULE, P, optionalIfMatch } from "./guards";
import { CreateCustomRuleBody, EditRuleConfigBody, parse } from "./m24-typebox";
import type { M24ReadService } from "./read-service";
import type { M24WriteService } from "./write-service";

export interface RuleConfigRouteDeps {
  readonly readService: M24ReadService;
  readonly writeService: M24WriteService;
}

const AI = rejectAiActor("AI principals cannot create or modify Medicaid billing records (D12)");
const IDEMPOTENT = requireIdempotencyKey();
const pParam = (request: { params: unknown }, key: string): string =>
  (request.params as Record<string, string>)[key] ?? "";

export function registerRuleConfigRoutes(app: FastifyInstance, deps: RuleConfigRouteDeps): void {
  const { readService, writeService } = deps;

  // 18 — read overlay + platform registry
  app.get(
    "/api/v1/medicaid-rule-config",
    {
      preHandler: [P("medicaid.rule_config.read")],
      config: {
        auditRead: {
          none: "Medicaid validation rule configuration — tenant policy, no patient data",
        },
      },
    },
    async (request, reply) => reply.send(await readService.listRuleConfig(m24ActorOf(request))),
  );

  // 19 — edit tenant overlay on non-regulatory rules
  app.patch(
    "/api/v1/medicaid-rule-config/:ruleKey",
    {
      preHandler: [
        P("medicaid.rule_config.edit"),
        ABAC_RULE("medicaid.rule_config.edit", "regulatory_required_rule_protected_medicaid"),
        AI,
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(EditRuleConfigBody, request.body);
      await writeService.editRuleConfig(m24ActorOf(request), pParam(request, "ruleKey"), {
        expectedVersion: optionalIfMatch(request),
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
      const body = parse(CreateCustomRuleBody, request.body);
      return reply.code(201).send(await writeService.createCustomRule(m24ActorOf(request), body));
    },
  );

  // 21 — delete custom rule (non-regulatory only)
  app.delete(
    "/api/v1/medicaid-rule-config/:ruleKey",
    {
      preHandler: [
        P("medicaid.rule_config.edit"),
        ABAC_RULE("medicaid.rule_config.edit", "regulatory_required_rule_protected_medicaid"),
        AI,
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      await writeService.deleteCustomRule(
        m24ActorOf(request),
        pParam(request, "ruleKey"),
        optionalIfMatch(request),
      );
      return reply.code(204).send();
    },
  );
}

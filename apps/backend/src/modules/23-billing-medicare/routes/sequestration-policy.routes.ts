// apps/backend/src/modules/23-billing-medicare/routes/sequestration-policy.routes.ts — M23 (§4.1 §4.7; F-212).
//
// The per-ProviderEntity sequestration-percentage timeline (D11) `POST /claims/assemble` applies: list the effective-dated
// policy rows, read the current (open-ended) one or the one effective on a date, ENTER a policy row, and SUPERSEDE a row
// (append-only correction). `percentage` is a decimal STRING the pure `applySequestration` consumes verbatim (never a float on the
// wire), validated to the 0-2% statutory band; an entry may start in the past (a tenant must be able to cover service dates
// that already happened), and overlap with a live row is a 409 (see the service). Reads gate `billing.sequestration_policy.read`;
// writes gate `billing.sequestration_policy.edit` (migration 0281 + the catalog sync grant both to `administrator`/`org_admin`
// only). Both compose the §4.7 `provider_entity_billing_scope` predicate over the ProviderEntity (query/body — the by-id routes
// carry it too and the service 404s a mismatch) + the §D13 AI-block + `Idempotency-Key` on mutations. NO PHI. Org/actor/
// membership binding is ALWAYS server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P, PROVIDER_SCOPE, targetProviderFromBody, targetProviderFromQuery } from "./guards";
import type { SequestrationPolicyRouteService } from "./sequestration-policy-service";
import {
  CreateSequestrationPolicyBodySchema,
  SequestrationPolicyEffectiveQuerySchema,
  SequestrationPolicyGetQuerySchema,
  SequestrationPolicyIdParamsSchema,
  SequestrationPolicyListQuerySchema,
  SupersedeSequestrationPolicyBodySchema,
  parse,
} from "./sequestration-policy-typebox";

export interface SequestrationPolicyRouteDeps {
  readonly sequestrationService: SequestrationPolicyRouteService;
}

const READ = P("billing.sequestration_policy.read");
const READ_ABAC = PROVIDER_SCOPE("billing.sequestration_policy.read", targetProviderFromQuery);
const EDIT = P("billing.sequestration_policy.edit");
const EDIT_ABAC = PROVIDER_SCOPE("billing.sequestration_policy.edit", targetProviderFromBody);
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const AUDIT_READ = {
  auditRead: { none: "sequestration withhold policy by period — payment policy, no patient data" },
} as const;

/** Register the §4.1 sequestration-policy routes (#32–#33 + active / effective / by-id reads + supersede). */
export function registerSequestrationPolicyRoutes(
  app: FastifyInstance,
  deps: SequestrationPolicyRouteDeps,
): void {
  const { sequestrationService } = deps;

  // GET /billing/sequestration-policies?providerEntityId=&includeSuperseded= — the effective-dated timeline. §4.1 #32.
  app.get(
    "/api/v1/billing/sequestration-policies",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(SequestrationPolicyListQuerySchema, request.query);
      return {
        policies: await sequestrationService.listPolicies(actor, q.providerEntityId, {
          includeSuperseded: q.includeSuperseded === true,
        }),
      };
    },
  );

  // GET /billing/sequestration-policies/active?providerEntityId= — the current open-ended policy (or null). §4.1.
  app.get(
    "/api/v1/billing/sequestration-policies/active",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(SequestrationPolicyGetQuerySchema, request.query);
      return sequestrationService.activePolicy(actor, q.providerEntityId);
    },
  );

  // GET /billing/sequestration-policies/effective?providerEntityId=&onDate= — the policy claim assembly would use (or null).
  app.get(
    "/api/v1/billing/sequestration-policies/effective",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(SequestrationPolicyEffectiveQuerySchema, request.query);
      return sequestrationService.effectivePolicy(actor, q.providerEntityId, q.onDate);
    },
  );

  // GET /billing/sequestration-policies/:id?providerEntityId=
  app.get(
    "/api/v1/billing/sequestration-policies/:id",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(SequestrationPolicyIdParamsSchema, request.params);
      const q = parse(SequestrationPolicyGetQuerySchema, request.query);
      return sequestrationService.getPolicy(actor, q.providerEntityId, id);
    },
  );

  // POST /billing/sequestration-policies — enter a policy row (201). §4.1 #33.
  app.post(
    "/api/v1/billing/sequestration-policies",
    { preHandler: [EDIT, EDIT_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateSequestrationPolicyBodySchema, request.body);
      return reply.code(201).send(await sequestrationService.createPolicy(actor, body));
    },
  );

  // POST /billing/sequestration-policies/:id/supersede — replace a live row with a corrected one (201; the old row is kept).
  app.post(
    "/api/v1/billing/sequestration-policies/:id/supersede",
    { preHandler: [EDIT, EDIT_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(SequestrationPolicyIdParamsSchema, request.params);
      const body = parse(SupersedeSequestrationPolicyBodySchema, request.body);
      return reply.code(201).send(await sequestrationService.supersedePolicy(actor, id, body));
    },
  );
}

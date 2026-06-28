// apps/backend/src/modules/23-billing-medicare/routes/sequestration-policy.routes.ts — M23 (§4.1 §4.7).
//
// The per-ProviderEntity sequestration-percentage timeline (D11): list the effective-dated policy rows (+ the
// active-on-now convenience read) and FORWARD-DATE a new policy row. `percentage` is a decimal STRING the
// pure `applySequestration` consumes verbatim (never a float on the wire). The DB CHECK forbids a non-future
// open period — the write service refuses a non-forward-dated effectiveFrom. Reads gate
// `billing.sequestration_policy.read`; the forward-date gates `billing.sequestration_policy.edit`. Both
// compose the §4.7 `provider_entity_billing_scope` predicate over the ProviderEntity (from the query on read,
// the body on write) + the §D13 AI-block on the mutation + `Idempotency-Key` (§4.1). NO PHI. Org/actor
// /membership binding is ALWAYS server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P, PROVIDER_SCOPE, targetProviderFromBody, targetProviderFromQuery } from "./guards";
import type { M23ReadRouteService } from "./read-service";
import type { M23WriteRouteService } from "./write-service";
import {
  ForwardDateSequestrationBodySchema,
  RequiredProviderEntityQuerySchema,
  parse,
} from "./billing-typebox";

export interface SequestrationPolicyRouteDeps {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
}

const READ = P("billing.sequestration_policy.read");
const READ_ABAC = PROVIDER_SCOPE("billing.sequestration_policy.read", targetProviderFromQuery);
const EDIT = P("billing.sequestration_policy.edit");
const EDIT_ABAC = PROVIDER_SCOPE("billing.sequestration_policy.edit", targetProviderFromBody);
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 sequestration-policy routes (#32–#33 + the active-on-now read). */
export function registerSequestrationPolicyRoutes(
  app: FastifyInstance,
  deps: SequestrationPolicyRouteDeps,
): void {
  const { readService, writeService } = deps;

  // GET /billing/sequestration-policies?providerEntityId= — the effective-dated timeline. §4.1 #32.
  app.get(
    "/api/v1/billing/sequestration-policies",
    { preHandler: [READ, READ_ABAC] },
    async (request) => {
      const actor = actorOf(request);
      const { providerEntityId } = parse(RequiredProviderEntityQuerySchema, request.query);
      return { policies: await readService.listSequestrationPolicies(actor, providerEntityId) };
    },
  );

  // GET /billing/sequestration-policies/active?providerEntityId= — the active-on-now policy (or null). §4.1.
  app.get(
    "/api/v1/billing/sequestration-policies/active",
    { preHandler: [READ, READ_ABAC] },
    async (request) => {
      const actor = actorOf(request);
      const { providerEntityId } = parse(RequiredProviderEntityQuerySchema, request.query);
      return readService.getActiveSequestrationPolicy(actor, providerEntityId);
    },
  );

  // POST /billing/sequestration-policies — forward-date a new policy row (201). §4.1 #33.
  app.post(
    "/api/v1/billing/sequestration-policies",
    { preHandler: [EDIT, EDIT_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(ForwardDateSequestrationBodySchema, request.body);
      const res = await writeService.forwardDateSequestrationPolicy(actor, {
        providerEntityId: body.providerEntityId,
        percentage: body.percentage,
        effectiveFrom: body.effectiveFrom,
        setReason: body.setReason,
      });
      return reply.code(201).send(res);
    },
  );
}

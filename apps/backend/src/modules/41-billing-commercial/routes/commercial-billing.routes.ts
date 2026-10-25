// apps/backend/src/modules/41-billing-commercial/routes/commercial-billing.routes.ts — M41 routes (issue #722, spec section 4.1).
//
//   POST /api/v1/billing/commercial/claims/assemble                                  assemble a commercial claim (201)
//   GET  /api/v1/billing/commercial/claims/:id                                       claim, lines and latest validation (read-audited)
//   POST /api/v1/billing/commercial/claims/:id/validate                              re-run the rules
//   POST /api/v1/billing/commercial/claims/:id/ready                                 draft -> ready, or 409 COMMERCIAL_CLAIM_BLOCKED
//   POST /api/v1/billing/commercial/claims/:id/void
//   POST /api/v1/billing/commercial/claims/:id/validation-results/:resultId/override audited override of a soft block (201)
//   POST /api/v1/billing/commercial/authorizations                                   record a pre-authorization (201)
//   POST /api/v1/billing/commercial/authorizations/:id/status                        deny or void one
//   GET  /api/v1/billing/commercial/authorizations?providerEntityId&patientId        list a patient's authorizations (read-audited)
//
// Every mutating route requires `Idempotency-Key`, rejects an AI actor, and carries the RBAC + ABAC pair; the override adds the
// step-up. Org / membership / step-up are read from the server-assembled request context, never the body.
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import {
  type PreHandler,
  actorOf,
  rejectAiActor,
  writeActorOf,
} from "../../23-billing-medicare/routes/actor";
import { parse } from "../../23-billing-medicare/routes/billing-typebox";
import { requireIdempotencyKey } from "../../23-billing-medicare/routes/concurrency";
import type { CommercialAuthorizationService } from "../services/authorization-service";
import type { CommercialClaimAssemblyService } from "../services/claim-assembly";
import type { CommercialClaimLifecycleService } from "../services/claim-lifecycle";
import { type CommercialClaimReadService, toRunApiView } from "../services/claim-read-service";
import {
  AssembleCommercialClaimBodySchema,
  AuthorizationListQuerySchema,
  IdParamsSchema,
  OverrideBodySchema,
  OverrideParamsSchema,
  RecordAuthorizationBodySchema,
  SetAuthorizationStatusBodySchema,
} from "./commercial-typebox";

export interface CommercialBillingRouteDeps {
  readonly assembly: CommercialClaimAssemblyService;
  readonly lifecycle: CommercialClaimLifecycleService;
  readonly authorizations: CommercialAuthorizationService;
  readonly reads: CommercialClaimReadService;
}

type Target = Record<string, unknown>;
type Req = { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown };
const claimFromParams = (r: Req): Target => ({
  claimId: (r.params as { id?: string } | undefined)?.id ?? "",
});
const authorizationFromParams = (r: Req): Target => ({
  authorizationId: (r.params as { id?: string } | undefined)?.id ?? "",
});
const providerFromBody = (r: Req): Target => ({
  providerEntityId: (r.body as { providerEntityId?: string } | undefined)?.providerEntityId ?? "",
});
const providerFromQuery = (r: Req): Target => ({
  providerEntityId: (r.query as { providerEntityId?: string } | undefined)?.providerEntityId ?? "",
});

const READ = requirePermission("commercial_billing.read") as PreHandler;
const WRITE = requirePermission("commercial_billing.write") as PreHandler;
const OVERRIDE = requirePermission("commercial_billing.override_validation") as PreHandler;
const SCOPE = (key: string, getTarget: (r: Req) => Target): PreHandler =>
  requireAbac(key, "commercial_billing_provider_scope", {
    getTarget,
    notFoundOnDeny: true,
  }) as PreHandler;
const CASELOAD = (key: string): PreHandler =>
  requireAbac(key, "commercial_claim_in_billing_caseload", {
    getTarget: claimFromParams,
    notFoundOnDeny: true,
  }) as PreHandler;
const OVERRIDE_ELIGIBLE = requireAbac(
  "commercial_billing.override_validation",
  "commercial_override_eligible",
  {
    getTarget: claimFromParams,
    notFoundOnDeny: true,
  },
) as PreHandler;
const STEP_UP = requireStepUp("commercial_billing.override_validation") as PreHandler;
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

/** Register the M41 claim and authorization routes. */
export function registerCommercialBillingRoutes(
  app: FastifyInstance,
  deps: CommercialBillingRouteDeps,
): void {
  const { assembly, lifecycle, authorizations, reads } = deps;

  app.post(
    "/api/v1/billing/commercial/claims/assemble",
    { preHandler: [WRITE, SCOPE("commercial_billing.write", providerFromBody), NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AssembleCommercialClaimBodySchema, request.body);
      const out = await assembly.assemble(writeActorOf(request), body);
      return reply.code(201).send({ ...out, validation: toRunApiView(out.validation) });
    },
  );

  app.get(
    "/api/v1/billing/commercial/claims/:id",
    {
      preHandler: [READ, CASELOAD("commercial_billing.read")],
      config: {
        auditRead: {
          resourceKind: "commercial_claim",
          resourceIdParam: "id",
          patientIdPayloadPath: "claim.patientId",
        },
      },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return reads.getClaim(actorOf(request), id);
    },
  );

  app.post(
    "/api/v1/billing/commercial/claims/:id/validate",
    { preHandler: [WRITE, CASELOAD("commercial_billing.write"), NO_AI, IDEMPOTENT] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return toRunApiView(await lifecycle.validate(writeActorOf(request), id));
    },
  );

  app.post(
    "/api/v1/billing/commercial/claims/:id/ready",
    { preHandler: [WRITE, CASELOAD("commercial_billing.write"), NO_AI, IDEMPOTENT] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      // A blocked claim is a 409 COMMERCIAL_CLAIM_BLOCKED carrying every blocking rule and an actionable message.
      const res = await lifecycle.assertReady(writeActorOf(request), id);
      return { claimId: res.claimId, state: res.state, validation: toRunApiView(res.validation) };
    },
  );

  app.post(
    "/api/v1/billing/commercial/claims/:id/void",
    { preHandler: [WRITE, CASELOAD("commercial_billing.write"), NO_AI, IDEMPOTENT] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return lifecycle.voidClaim(writeActorOf(request), id);
    },
  );

  app.post(
    "/api/v1/billing/commercial/claims/:id/validation-results/:resultId/override",
    { preHandler: [OVERRIDE, OVERRIDE_ELIGIBLE, STEP_UP, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const { id, resultId } = parse(OverrideParamsSchema, request.params);
      const body = parse(OverrideBodySchema, request.body);
      const out = await lifecycle.overrideValidationResult(writeActorOf(request), id, {
        validationResultId: resultId,
        reason: body.reason,
      });
      return reply.code(201).send(out);
    },
  );

  app.post(
    "/api/v1/billing/commercial/authorizations",
    { preHandler: [WRITE, SCOPE("commercial_billing.write", providerFromBody), NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(RecordAuthorizationBodySchema, request.body);
      return reply.code(201).send(await authorizations.record(writeActorOf(request), body));
    },
  );

  app.post(
    "/api/v1/billing/commercial/authorizations/:id/status",
    {
      preHandler: [
        WRITE,
        SCOPE("commercial_billing.write", authorizationFromParams),
        NO_AI,
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(SetAuthorizationStatusBodySchema, request.body);
      return authorizations.setStatus(writeActorOf(request), id, body.status);
    },
  );

  app.get(
    "/api/v1/billing/commercial/authorizations",
    {
      preHandler: [READ, SCOPE("commercial_billing.read", providerFromQuery)],
      config: {
        auditRead: {
          resourceKind: "commercial_authorization",
          list: true,
          patientIdQueryParam: "patientId",
        },
      },
    },
    async (request) => {
      const q = parse(AuthorizationListQuerySchema, request.query);
      return { items: await authorizations.listForPatient(actorOf(request), q.patientId) };
    },
  );
}

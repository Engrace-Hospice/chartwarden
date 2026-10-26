// apps/backend/src/modules/41-billing-commercial/routes/commercial-billing.routes.ts — M41 routes (issue #722, spec section 4.1).
//
//   POST /api/v1/billing/commercial/claims/assemble                                  assemble a commercial claim (201)
//   GET  /api/v1/billing/commercial/claims?providerEntityId&state&payerKind&patientId&limit   work queue (read-audited list)
//   GET  /api/v1/billing/commercial/payer-plans?providerEntityId                     supported payers: plans, payer state, routes
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
import { COMMERCIAL_BILLING_PERMISSIONS } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { billingScopeReach } from "../../23-billing-medicare/abac-predicates";
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
import type { CommercialSubmissionService } from "../services/submission-service";
import {
  AssembleCommercialClaimBodySchema,
  AuthorizationListQuerySchema,
  ClaimListQuerySchema,
  IdParamsSchema,
  OverrideBodySchema,
  OverrideParamsSchema,
  PlanListQuerySchema,
  RecordAuthorizationBodySchema,
  SetAuthorizationStatusBodySchema,
} from "./commercial-typebox";
import { idempotencyKeyOf } from "./guards";

export interface CommercialBillingRouteDeps {
  readonly assembly: CommercialClaimAssemblyService;
  readonly lifecycle: CommercialClaimLifecycleService;
  readonly authorizations: CommercialAuthorizationService;
  readonly reads: CommercialClaimReadService;
  readonly submissions: CommercialSubmissionService;
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

/**
 * The actor the services receive: the server-assembled identity PLUS the provider entities the actor's billing scope reaches
 * (`billingScopeReach`), so every service checks the DATA it touches against the actor and not only the route's named entity.
 */
function billingScopeOf(request: FastifyRequest) {
  const reach = billingScopeReach(request.context);
  return { all: reach.all, providerEntityIds: reach.providerEntityIds };
}
const writeActor = (request: FastifyRequest) => ({
  ...writeActorOf(request),
  billingScope: billingScopeOf(request),
});
const readActor = (request: FastifyRequest) => ({
  ...actorOf(request),
  billingScope: billingScopeOf(request),
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
const SUBMIT = requirePermission(COMMERCIAL_BILLING_PERMISSIONS.SUBMIT) as PreHandler;
const SUBMIT_STEP_UP = requireStepUp(COMMERCIAL_BILLING_PERMISSIONS.SUBMIT) as PreHandler;
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

/** Register the M41 claim and authorization routes. */
export function registerCommercialBillingRoutes(
  app: FastifyInstance,
  deps: CommercialBillingRouteDeps,
): void {
  const { assembly, lifecycle, authorizations, reads, submissions } = deps;

  app.post(
    "/api/v1/billing/commercial/claims/assemble",
    { preHandler: [WRITE, SCOPE("commercial_billing.write", providerFromBody), NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AssembleCommercialClaimBodySchema, request.body);
      const out = await assembly.assemble(writeActor(request), body);
      return reply.code(201).send({ ...out, validation: toRunApiView(out.validation) });
    },
  );

  // Work queue: the claims of ONE provider entity (the ABAC pair proves the actor's reach), newest change first.
  app.get(
    "/api/v1/billing/commercial/claims",
    {
      preHandler: [READ, SCOPE("commercial_billing.read", providerFromQuery)],
      config: {
        auditRead: {
          resourceKind: "commercial_claim",
          list: true,
          patientIdQueryParam: "patientId",
        },
      },
    },
    async (request) => {
      const q = parse(ClaimListQuerySchema, request.query);
      return reads.listClaims(readActor(request), q);
    },
  );

  // Supported payers: the tenant's commercial plans with payer state and clearinghouse routes. No patient data.
  app.get(
    "/api/v1/billing/commercial/payer-plans",
    {
      preHandler: [READ, SCOPE("commercial_billing.read", providerFromQuery)],
      config: {
        auditRead: {
          none: "Plan rows: payer id, plan name, filing indicator, authorization policy, routes. No patient, member or coverage data",
        },
      },
    },
    async (request) => {
      const q = parse(PlanListQuerySchema, request.query);
      return reads.listPlans(readActor(request), q.providerEntityId);
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
      return reads.getClaim(readActor(request), id);
    },
  );

  app.post(
    "/api/v1/billing/commercial/claims/:id/validate",
    { preHandler: [WRITE, CASELOAD("commercial_billing.write"), NO_AI, IDEMPOTENT] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return toRunApiView(await lifecycle.validate(writeActor(request), id));
    },
  );

  app.post(
    "/api/v1/billing/commercial/claims/:id/ready",
    { preHandler: [WRITE, CASELOAD("commercial_billing.write"), NO_AI, IDEMPOTENT] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      // A blocked claim is a 409 COMMERCIAL_CLAIM_BLOCKED carrying every blocking rule and an actionable message.
      const res = await lifecycle.assertReady(writeActor(request), id);
      return { claimId: res.claimId, state: res.state, validation: toRunApiView(res.validation) };
    },
  );

  // The send gate, before the click: every reason a claim cannot be sent now, each with a stable code and a fixed message.
  app.get(
    "/api/v1/billing/commercial/claims/:id/send-gate",
    {
      preHandler: [READ, CASELOAD("commercial_billing.read")],
      config: {
        auditRead: {
          resourceKind: "commercial_claim",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return submissions.sendGate(readActor(request), id);
    },
  );

  // The claim's history: state changes and submissions in order (ids, dates and codes only), bounded.
  app.get(
    "/api/v1/billing/commercial/claims/:id/timeline",
    {
      preHandler: [READ, CASELOAD("commercial_billing.read")],
      config: {
        auditRead: {
          resourceKind: "commercial_claim",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return submissions.timeline(readActor(request), id);
    },
  );

  // Sending a claim is consequential and irreversible once the payer has it, so it follows M23's filing actions: its own permission, the
  // claim's provider/caseload scope, a FRESH step-up, no AI actor and an Idempotency-Key. The route only decides and records (202,
  // `queued`); the worker sends, and the claim stays `ready` until the transport has accepted the file.
  app.post(
    "/api/v1/billing/commercial/claims/:id/submit",
    {
      preHandler: [
        SUBMIT,
        CASELOAD("commercial_billing.submit"),
        SUBMIT_STEP_UP,
        NO_AI,
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { id } = parse(IdParamsSchema, request.params);
      const out = await submissions.submit(writeActor(request), id, idempotencyKeyOf(request));
      return reply.code(out.replayed ? 200 : 202).send(out);
    },
  );

  app.post(
    "/api/v1/billing/commercial/claims/:id/void",
    { preHandler: [WRITE, CASELOAD("commercial_billing.write"), NO_AI, IDEMPOTENT] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return lifecycle.voidClaim(writeActor(request), id);
    },
  );

  app.post(
    "/api/v1/billing/commercial/claims/:id/validation-results/:resultId/override",
    { preHandler: [OVERRIDE, OVERRIDE_ELIGIBLE, STEP_UP, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const { id, resultId } = parse(OverrideParamsSchema, request.params);
      const body = parse(OverrideBodySchema, request.body);
      const out = await lifecycle.overrideValidationResult(writeActor(request), id, {
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
      return reply.code(201).send(await authorizations.record(writeActor(request), body));
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
      return authorizations.setStatus(writeActor(request), id, body.status);
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
      return {
        items: await authorizations.listForPatient(
          readActor(request),
          q.providerEntityId,
          q.patientId,
        ),
      };
    },
  );
}

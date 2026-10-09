// apps/backend/src/modules/23-billing-medicare/routes/visit-charge.routes.ts — M23 (migration 1056).
//
// The TENANT-ENTERED hospice visit-charge schedule `POST /claims/assemble` bills each visit line from: enter a schedule
// version (a charge per 15-minute unit per discipline), list / get / look up the version effective on a date, and
// SUPERSEDE a version (append-only correction). Reads gate `billing.visit_charge.read`; writes gate
// `billing.visit_charge.admin` (a financial input — administrators only; migration 1056 grants it to
// `administrator`/`org_admin`). Both compose the §4.7 `provider_entity_billing_scope` predicate over the ProviderEntity
// (query/body — the by-id routes carry it too and the service 404s a mismatch) + the §D13 AI-block + `Idempotency-Key`
// on mutations. NO PHI. Org/actor/membership binding is ALWAYS server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P, PROVIDER_SCOPE, targetProviderFromBody, targetProviderFromQuery } from "./guards";
import type { VisitChargeRouteService } from "./visit-charge-service";
import {
  CreateVisitChargeBodySchema,
  SupersedeVisitChargeBodySchema,
  VisitChargeEffectiveQuerySchema,
  VisitChargeGetQuerySchema,
  VisitChargeIdParamsSchema,
  VisitChargeListQuerySchema,
  assertWholeCents,
  parse,
} from "./visit-charge-typebox";

export interface VisitChargeRouteDeps {
  readonly visitChargeService: VisitChargeRouteService;
}

const READ = P("billing.visit_charge.read");
const READ_ABAC = PROVIDER_SCOPE("billing.visit_charge.read", targetProviderFromQuery);
const ADMIN = P("billing.visit_charge.admin");
const ADMIN_ABAC = PROVIDER_SCOPE("billing.visit_charge.admin", targetProviderFromBody);
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const AUDIT_READ = {
  auditRead: { none: "hospice visit-charge schedule — billing policy data, no patient data" },
} as const;

export function registerVisitChargeRoutes(app: FastifyInstance, deps: VisitChargeRouteDeps): void {
  const { visitChargeService } = deps;

  // GET /billing/visit-charge-schedules?providerEntityId=&includeSuperseded= — versions, newest window first.
  app.get(
    "/api/v1/billing/visit-charge-schedules",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(VisitChargeListQuerySchema, request.query);
      return {
        visitChargeSchedules: await visitChargeService.listVisitCharges(actor, q.providerEntityId, {
          includeSuperseded: q.includeSuperseded === true,
        }),
      };
    },
  );

  // GET /billing/visit-charge-schedules/effective?providerEntityId=&onDate= — the live version claim assembly would use.
  app.get(
    "/api/v1/billing/visit-charge-schedules/effective",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(VisitChargeEffectiveQuerySchema, request.query);
      return visitChargeService.effectiveVisitCharge(actor, q.providerEntityId, q.onDate);
    },
  );

  // GET /billing/visit-charge-schedules/:id?providerEntityId=
  app.get(
    "/api/v1/billing/visit-charge-schedules/:id",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(VisitChargeIdParamsSchema, request.params);
      const q = parse(VisitChargeGetQuerySchema, request.query);
      return visitChargeService.getVisitCharge(actor, q.providerEntityId, id);
    },
  );

  // POST /billing/visit-charge-schedules — enter a new schedule version (201).
  app.post(
    "/api/v1/billing/visit-charge-schedules",
    { preHandler: [ADMIN, ADMIN_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      assertWholeCents(request.body);
      const body = parse(CreateVisitChargeBodySchema, request.body);
      return reply.code(201).send(await visitChargeService.createVisitCharge(actor, body));
    },
  );

  // POST /billing/visit-charge-schedules/:id/supersede — replace a live version with a corrected one (201; old row kept).
  app.post(
    "/api/v1/billing/visit-charge-schedules/:id/supersede",
    { preHandler: [ADMIN, ADMIN_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(VisitChargeIdParamsSchema, request.params);
      assertWholeCents(request.body);
      const body = parse(SupersedeVisitChargeBodySchema, request.body);
      return reply.code(201).send(await visitChargeService.supersedeVisitCharge(actor, id, body));
    },
  );
}

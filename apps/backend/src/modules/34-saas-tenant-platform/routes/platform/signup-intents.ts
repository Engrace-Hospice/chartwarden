// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/signup-intents.ts — M34 (§4.1
// platform-ops). The pre-provision signup-intent QUEUE (F02 / ADR-0010): the org-LESS intake funnel a
// platform-ops actor triages. List (the triage queue across tenants), qualify (`new → qualified` →
// enqueues the same `tenant.provision` flow as the Phase-1 path, §7.1), reject (`new → rejected` with a
// rationale). DISTINCT from the public self-serve `routes/public/signup-intents.ts` — this is the
// platform-ops control surface. The `tenant_signup_intent` table is genuinely pre-organization, so its
// reads/writes run under `withPlatformContext` (the M1 RLS-bypass platform reader, F03/F09 — there is no
// org to scope to yet); that binding is the route-service adapter's job.
//
// Every route is gated by the REAL Authorization Contract on the §4.5 keys + `tenant_lifecycle_platform_ops`
// ABAC. List is fully live (repo → withPlatformContext → typed page). Qualify ENQUEUES the §4.3
// `tenant.provision` job through the service's injected enqueue port; the live BullMQ worker construction
// is Phase 2D (see platform/service.ts TODO). Mirrors the sibling tenants.ts plugin shape.
import { requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  IntentParamsSchema,
  QualifyIntentRequest,
  RejectIntentRequest,
  SignupIntentListQuerySchema,
  parse,
} from "./platform-typebox";
import type { TenantPlatformRouteService } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SignupIntentRouteDeps {
  /** The §4.1 platform-ops route service (in-memory slice; Drizzle under `withPlatformContext` + enqueue). */
  service: TenantPlatformRouteService;
}

function actorOf(request: FastifyRequest): { userId: string; membershipId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  if (typeof membershipId !== "string") throw new UnauthorizedError();
  return { userId: ctx.userId, membershipId };
}

const intentIdOf = (request: FastifyRequest): string =>
  parse(IntentParamsSchema, request.params).id;

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const LIST = P("signup_intent.list_platform");
const QUALIFY = P("signup_intent.qualify");

const A = (key: string): PreHandler =>
  requireAbac(key, "tenant_lifecycle_platform_ops") as PreHandler;
const ABAC_LIST = A("signup_intent.list_platform");
const ABAC_QUALIFY = A("signup_intent.qualify");

export function registerSignupIntentRoutes(
  app: FastifyInstance,
  deps: SignupIntentRouteDeps,
): void {
  const { service } = deps;

  // 1 — list the signup-intent triage queue (cursor-paginated; status/source filters). §4.1.
  app.get("/api/v1/platform/signup-intents", { preHandler: [LIST, ABAC_LIST] }, async (request) => {
    actorOf(request);
    const q = parse(SignupIntentListQuerySchema, request.query);
    return service.listSignupIntents({ status: q.status, source: q.source }, q.cursor, q.limit);
  });

  // 2 — qualify an intent (`new → qualified`); enqueues the `tenant.provision` flow (§7.1). §4.1.
  app.post(
    "/api/v1/platform/signup-intents/:id/qualify",
    { preHandler: [QUALIFY, ABAC_QUALIFY] },
    async (request, reply) => {
      const { membershipId } = actorOf(request);
      const body = parse(QualifyIntentRequest, request.body);
      const res = await service.qualifyIntent(intentIdOf(request), membershipId, {
        planLabel: body.planLabel,
        firstAdminFullName: body.firstAdminFullName,
      });
      return reply.code(202).send(res);
    },
  );

  // 3 — reject an intent (`new → rejected`) with a recorded rationale (the §4.1 qualify route's reject branch).
  app.post(
    "/api/v1/platform/signup-intents/:id/reject",
    { preHandler: [QUALIFY, ABAC_QUALIFY] },
    async (request) => {
      // membershipId (not userId) — matches the sibling qualifyIntent call above; the service
      // currently discards this parameter (`void actorUserId` in service-drizzle.ts), but the
      // moment that plumbing is wired up it must receive a membership id, not the raw user id.
      const { membershipId } = actorOf(request);
      const body = parse(RejectIntentRequest, request.body);
      return service.rejectIntent(intentIdOf(request), membershipId, {
        rejectionReason: body.rejectionReason,
      });
    },
  );
}

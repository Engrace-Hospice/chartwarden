// apps/backend/src/modules/08-encounters/routes/drafting-routes.ts — the visit-note draft switch routes (ADR-0114 VN-D17, PR C1).
//
//   GET /api/v1/encounters/draft-policy   the tenant's switch + the corpus review state   encounter.draft_policy_admin
//   PUT /api/v1/encounters/draft-policy   switch it on or off (step-up)                   encounter.draft_policy_admin
//
// A STATIC segment under `/api/v1/encounters/`, registered next to the `:encounterId` routes; the router prefers a static segment over
// a parameter, and visit-note-draft-routes.test.ts proves it is not swallowed. Org and actor come from the server-assembled
// `request.context`, never the body. Errors are typed ChartWardenError only (the service throws them): enabling while the phrase
// corpus has not had its clinical review is a 409 CORPUS_REVIEW_PENDING.
import type { AuditContext } from "@chartwarden/audit";
import { requirePermission, requireStepUp } from "@chartwarden/auth";
import { type PreHandler, rejectAiActor, writeActorOf } from "@chartwarden/shared/route-kit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DraftActor, DraftRouteService } from "../drafting/route-service";
import { PutDraftPolicySchema } from "./drafting-typebox";
import { parse } from "./encounters-typebox";

export interface DraftingRouteDeps {
  readonly service: DraftRouteService;
}

const DRAFT_POLICY_ADMIN = requirePermission("encounter.draft_policy_admin") as PreHandler;
/** The switch write rides its own step-up operation key, so a tenant can tune it apart from the closure policy. */
export const DRAFT_POLICY_STEP_UP_KEY = "encounter.draft_policy_admin";
const STEP_UP = requireStepUp(DRAFT_POLICY_STEP_UP_KEY) as PreHandler;
// An AI principal may not switch the draft (or its sign gate) on or off (D13).
const NO_AI = rejectAiActor(
  "AI principals cannot change the visit-note draft policy (D13)",
) as PreHandler;

function draftActorOf(request: FastifyRequest): DraftActor {
  const { organizationId, userId, membershipId } = writeActorOf(request);
  return { organizationId, userId, membershipId };
}

function auditContextOf(request: FastifyRequest): AuditContext {
  const ctx = request.context;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    actorKind: "user",
    correlationId: ctx.correlationId,
    requestId: String(request.id),
    sourceIp: ctx.ip,
    userAgent: ctx.userAgent,
  };
}

export function registerDraftingRoutes(app: FastifyInstance, deps: DraftingRouteDeps): void {
  const { service } = deps;

  app.get(
    "/api/v1/encounters/draft-policy",
    {
      preHandler: [DRAFT_POLICY_ADMIN],
      config: {
        auditRead: {
          none: "organization-level visit-note draft switch and corpus review state; no patient data",
        },
      },
    },
    async (request) => service.getPolicy(draftActorOf(request).organizationId),
  );

  // Step-up: switching the draft on changes what every clinician of the tenant must resolve before they can sign.
  app.put(
    "/api/v1/encounters/draft-policy",
    { preHandler: [DRAFT_POLICY_ADMIN, NO_AI, STEP_UP] },
    async (request) => {
      const actor = draftActorOf(request);
      const body = parse(PutDraftPolicySchema, request.body);
      return service.putPolicy(actor, body, auditContextOf(request));
    },
  );
}

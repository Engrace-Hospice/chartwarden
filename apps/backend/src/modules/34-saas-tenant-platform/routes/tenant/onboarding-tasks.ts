// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/onboarding-tasks.ts — M34 §4.1.
//
// The TENANT-scoped onboarding routes (`withOrgContext` — the tenant's own org). The eleven-step onboarding
// state machine (D3) is data-driven off the platform-shared `onboarding_task_template` catalog; this surface
// lets the tenant read its own onboarding state and advance per-task (start → in_progress, complete →
// done with completion evidence + precondition-DSL evaluation (422 if false), block → blocked with reason +
// M36 alert). Routes gate on the §4.5 keys + the §4.6 ABAC predicate `onboarding_task_assignee_or_owner`
// (the task's assignee OR org_admin). No step-up on this surface (§6/D10). The read surface is
// auditRead-declared in the Drizzle service. Mirrors registerDocumentRoutes EXACTLY.
import { requireAbac, requirePermission } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf } from "./actor";
import type { TenantRouteService } from "./service";
import {
  OnboardingBlockRequest,
  OnboardingCompleteRequest,
  OnboardingListQuerySchema,
  OnboardingStartRequest,
  OnboardingTaskParamsSchema,
  parse,
} from "./tenant-typebox";

export interface OnboardingRouteDeps {
  service: TenantRouteService;
}

// §4.5 permission guards.
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("onboarding.read_own");
const UPDATE = P("onboarding.update");

// §4.6 ABAC — the task's assignee OR org_admin (target = the resolved `:taskId`'s assignee facts in prod;
// the request `:taskId` is surfaced as the target so the predicate is exercisable end-to-end — the M22
// precedent of surfacing the route id as the AbacTarget).
const ABAC_READ = requireAbac(
  "onboarding.read_own",
  "onboarding_task_assignee_or_owner",
) as PreHandler;
const ABAC_UPDATE = requireAbac(
  "onboarding.update",
  "onboarding_task_assignee_or_owner",
) as PreHandler;

export function registerOnboardingRoutes(app: FastifyInstance, deps: OnboardingRouteDeps): void {
  const { service } = deps;

  // read own onboarding state (cursor-paginated) (§4.1).
  app.get("/api/v1/tenant/onboarding", { preHandler: [READ, ABAC_READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parse(OnboardingListQuerySchema, request.query);
    return service.listOnboarding(organizationId, q.cursor, q.limit);
  });

  // flip pending → in_progress (§4.1).
  app.post(
    "/api/v1/tenant/onboarding/:taskId/start",
    { preHandler: [UPDATE, ABAC_UPDATE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { taskId } = parse(OnboardingTaskParamsSchema, request.params);
      parse(OnboardingStartRequest, request.body);
      return service.startOnboardingTask(organizationId, taskId);
    },
  );

  // provide completion evidence; precondition DSL evaluated → 422 if false (§4.1).
  app.post(
    "/api/v1/tenant/onboarding/:taskId/complete",
    { preHandler: [UPDATE, ABAC_UPDATE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { taskId } = parse(OnboardingTaskParamsSchema, request.params);
      const body = parse(OnboardingCompleteRequest, request.body);
      return service.completeOnboardingTask(
        organizationId,
        taskId,
        body.completionEvidence ?? null,
      );
    },
  );

  // flip in_progress → blocked with reason; emits M36 (§4.1).
  app.post(
    "/api/v1/tenant/onboarding/:taskId/block",
    { preHandler: [UPDATE, ABAC_UPDATE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { taskId } = parse(OnboardingTaskParamsSchema, request.params);
      const body = parse(OnboardingBlockRequest, request.body);
      return service.blockOnboardingTask(organizationId, taskId, body.blockerReason);
    },
  );
}

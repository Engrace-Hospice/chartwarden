// apps/backend/src/modules/02-identity/routes/organization-lifecycle-routes.ts — §11 D19 (#205 hard
// half). The ONE route the M35 spec's own worked example names: "a `platform_admin` suspends the org
// via M2 admin route" (§11 D19). Gated on `org.manage` (packages/auth/src/permissions/contributed.ts —
// declared since the catalog's founding, bound by NO route until this one) + the
// `organization_lifecycle_platform_ops` ABAC predicate (../abac-predicates.ts, the M29
// `nppes_platform_job_caller` shape: a tenant-scoped role cannot suspend an arbitrary org; a
// platform-ops role can) + a fresh step-up (this changes who can sign in to an entire tenant).
//
// The acting membership id is read off `request.context.attributes.membershipId` (F-030's produced
// fact), the M34 `tenants.ts` `actorOf()` precedent — NOT off M2's own `Actor` type, whose
// `createContextActorResolver` hardcodes `membershipId: null` (that field answers a different
// question: the CALLER's own membership in the org their session is bound to, not the id this route
// wants to attribute the transition to, which may be a platform-ops actor's membership in a
// DIFFERENT org than the one being suspended).
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { UnauthorizedError, ValidationError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  OrganizationLifecycleEvent,
  OrganizationLifecycleWriter,
} from "../organization-lifecycle";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const PERMISSION_KEY = "org.manage";
const ABAC_PREDICATE = "organization_lifecycle_platform_ops";
const STEP_UP_OP = "organization.transition_status";

const TRANSITION = requirePermission(PERMISSION_KEY) as PreHandler;
const ABAC_TRANSITION = requireAbac(PERMISSION_KEY, ABAC_PREDICATE) as PreHandler;
const STEPUP_TRANSITION = requireStepUp(STEP_UP_OP) as PreHandler;

const EVENTS: readonly OrganizationLifecycleEvent[] = ["activate", "suspend", "close"];

function actorMembershipId(request: FastifyRequest): string {
  const id = request.context?.attributes?.membershipId;
  if (typeof id !== "string") throw new UnauthorizedError();
  return id;
}

function readEvent(body: unknown): OrganizationLifecycleEvent {
  const value = (body as Record<string, unknown> | null)?.event;
  if (typeof value !== "string" || !EVENTS.includes(value as OrganizationLifecycleEvent)) {
    throw new ValidationError("invalid event", [
      { field: "event", code: "INVALID", message: "event must be one of activate/suspend/close" },
    ]);
  }
  return value as OrganizationLifecycleEvent;
}

function readReason(body: unknown): string {
  const value = (body as Record<string, unknown> | null)?.reason;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError("invalid reason", [
      { field: "reason", code: "REQUIRED", message: "a non-empty transition reason is required" },
    ]);
  }
  return value;
}

export function registerOrganizationLifecycleRoutes(
  app: FastifyInstance,
  writer: OrganizationLifecycleWriter,
): void {
  app.post(
    "/api/v1/platform/organizations/:organizationId/status",
    { preHandler: [TRANSITION, ABAC_TRANSITION, STEPUP_TRANSITION] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      if (!organizationId)
        throw new WardenXError("VALIDATION_FAILED", "organizationId is required", 400);
      const event = readEvent(request.body);
      const reason = readReason(request.body);
      const ctx = request.context;
      if (!ctx?.userId) throw new UnauthorizedError();

      const result = await writer.transition(organizationId, event, {
        reason,
        actorUserId: ctx.userId,
        actorMembershipId: actorMembershipId(request),
      });
      return reply.code(202).send(result);
    },
  );
}

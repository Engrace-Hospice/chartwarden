// apps/backend/src/modules/02-identity/routes/platform-user-routes.ts — the §4.7 `user.deactivate`
// "platform_ops (any)" grant, as its own PLATFORM route:
//
//   POST /api/v1/platform/users/:id/deactivate   deactivate a user platform-wide, regardless of org
//
// The tenant route (`POST /api/v1/users/:id/deactivate`, identity-routes.ts) is org-bounded since GAP-001:
// the target must be a live member of the caller's org and of no other. That left the spec's cross-org
// platform grant unserved; this route serves it, and decides on the PLATFORM ROLE rather than on the
// `user.deactivate` permission alone (an org_admin holds that key too, for their own org).
//
// Guards, the organization-lifecycle-routes.ts shape (the sibling M2 platform route):
//   1. `requirePermission("user.deactivate")` — the §4.7 key the spec binds to platform_ops.
//   2. `requireAbac(_, "user_lifecycle_platform_ops")` — the caller holds a platform-owned
//      platform_ops / platform_admin / platform_owner role (../abac-predicates.ts). `context.roles`
//      carries a `platform_*` key only from an `organization_id IS NULL` row (GAP-003 `roleConfersKey`),
//      so a tenant-minted `platform_ops` role fails here even with the permission.
//   3. `requireStepUp("user.deactivate_platform")` — a fresh step-up: this locks a person out of every
//      tenant at once.
//
// Effects mirror the tenant route: flip `user.status` and revoke every live membership in every org
// (§2.2.1 / §2.4 — atomic, under the same user-row lock as `deactivateFromOrg`), reap ALL the user's sessions, audit `m2.user.deactivated` and publish it — both
// marked `scope: "platform"`, attributed to the operator's own bound org (the audit/outbox RLS context),
// with the audit row naming every org the user was still a live member of. A repeat call is idempotent:
// 200 `alreadyDeactivated: true`, sessions reaped and live memberships swept again (a session or membership
// minted since is still cut), no second audit row or event. No per-org `m2.membership.revoked` events: each
// would need that org's outbox RLS context (the port fails closed on a foreign org) and nothing consumes
// them; the revoked ids ride on the audit row instead.
import type { AuditContext } from "@wardenx/audit";
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { UnauthorizedError, ValidationError, ChartWardenError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auditUserDeactivated } from "../audit/identity-audit";
import type { IdentityRouteDeps } from "../identity-ports";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const PERMISSION_KEY = "user.deactivate";
const ABAC_PREDICATE = "user_lifecycle_platform_ops";
const STEP_UP_OP = "user.deactivate_platform";

const DEACTIVATE = requirePermission(PERMISSION_KEY) as PreHandler;
const ABAC_DEACTIVATE = requireAbac(PERMISSION_KEY, ABAC_PREDICATE) as PreHandler;
const STEPUP_DEACTIVATE = requireStepUp(STEP_UP_OP) as PreHandler;

/** The slice of the identity deps this route needs. */
export type PlatformUserRouteDeps = Pick<
  IdentityRouteDeps,
  "actors" | "users" | "sessions" | "audit" | "outbox"
>;

function readReason(body: unknown): string {
  const value = (body as Record<string, unknown> | null)?.reason;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError("invalid reason", [
      { field: "reason", code: "REQUIRED", message: "a non-empty deactivation reason is required" },
    ]);
  }
  return value;
}

function auditContextFor(request: FastifyRequest, actorUserId: string): AuditContext {
  return {
    organizationId: request.context.organizationId || null,
    userId: actorUserId,
    actorKind: "user",
    correlationId: request.context.correlationId,
    requestId: String(request.id),
    sourceIp: request.context.ip,
    userAgent: request.context.userAgent,
  };
}

export function registerPlatformUserRoutes(
  app: FastifyInstance,
  deps: PlatformUserRouteDeps,
): void {
  app.post(
    "/api/v1/platform/users/:id/deactivate",
    { preHandler: [DEACTIVATE, ABAC_DEACTIVATE, STEPUP_DEACTIVATE] },
    async (request, reply) => {
      const userId = (request.params as { id: string }).id;
      const reason = readReason(request.body);
      const actor = await deps.actors.resolve(request);
      if (!actor) throw new UnauthorizedError();

      const { outcome, memberOrganizationIds, revokedMemberships } =
        await deps.users.deactivateGlobally({ userId });
      if (outcome === "not_found") throw new ChartWardenError("NOT_FOUND", "user not found", 404);

      const sessionsRevoked = await deps.sessions.revokeAllForUser(userId);
      if (outcome === "deactivated") {
        await auditUserDeactivated(deps.audit, auditContextFor(request, actor.userId), {
          userId,
          reason,
          scope: "platform",
          memberOrganizationIds,
          revokedMembershipIds: revokedMemberships.map((m) => m.membershipId),
        });
        await deps.outbox?.publish({
          eventName: "m2.user.deactivated",
          payload: { userId, reason, scope: "platform" },
          organizationId: request.context.organizationId || null,
          aggregateKind: "user",
          aggregateId: userId,
        });
      }
      return reply.code(200).send({
        deactivated: true,
        alreadyDeactivated: outcome === "already_deactivated",
        sessionsRevoked,
        membershipsRevoked: revokedMemberships.length,
      });
    },
  );
}

// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/tenant-invitations.ts — M34 (§4.1).
//
// The platform → first-admin `tenant_invitation` lifecycle routes (§4.1 platform-ops table): list across
// tenants, issue a single-use token (sent via M36), and revoke a pending invitation. Gated by the REAL
// Authorization Contract on the §4.5 keys + the `tenant_lifecycle_platform_ops` ABAC predicate M34 owns;
// the issue route additionally requires §6 step-up. Cross-tenant reads run under `withPlatformContext`
// (F03/F09, audited) in prod; org/actor binding is server-side. Mirrors the M22 route-plugin shape.
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  InvitationListQuerySchema,
  InvitationParamsSchema,
  IssueInvitationRequest,
  parse,
} from "./platform-typebox";
import type { TenantPlatformRouteService } from "./service";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface TenantInvitationRouteDeps {
  service: TenantPlatformRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  // `userId` here is the acting MEMBERSHIP id — `issueInvitation()` writes it straight into
  // `tenant_invitation.inviter_membership_id` ("M2 membership (app-validated)"). This used to read
  // `ctx.userId` (the raw Better Auth user id, a different id space); matches the fail-closed
  // pattern in the sibling `tenants.ts` `actorOf`.
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId };
}

// §4.5 permission + §4.6 ABAC (`tenant_lifecycle_platform_ops`) + §6 step-up (issue only).
const LIST = requirePermission("tenant_invitation.list_platform") as PreHandler;
const ISSUE = requirePermission("tenant_invitation.issue") as PreHandler;
const REVOKE = requirePermission("tenant_invitation.revoke") as PreHandler;
const ABAC_LIST = requireAbac(
  "tenant_invitation.list_platform",
  "tenant_lifecycle_platform_ops",
) as PreHandler;
const ABAC_ISSUE = requireAbac(
  "tenant_invitation.issue",
  "tenant_lifecycle_platform_ops",
) as PreHandler;
const ABAC_REVOKE = requireAbac(
  "tenant_invitation.revoke",
  "tenant_lifecycle_platform_ops",
) as PreHandler;
const STEPUP_ISSUE = requireStepUp("tenant_invitation.issue") as PreHandler;

/** Register the §4.1 platform → first-admin tenant-invitation routes. */
export function registerTenantInvitationRoutes(
  app: FastifyInstance,
  deps: TenantInvitationRouteDeps,
): void {
  const { service } = deps;

  // 1 — list platform → first-admin invitations across tenants (cursor-paginated). §4.1.
  app.get(
    "/api/v1/platform/tenant-invitations",
    { preHandler: [LIST, ABAC_LIST] },
    async (request) => {
      actorOf(request);
      const q = parse(InvitationListQuerySchema, request.query);
      return service.listInvitations({ status: q.status }, q.cursor, q.limit);
    },
  );

  // 2 — issue a `tenant_invitation` row + single-use token email via M36 (step-up). §4.1.
  app.post(
    "/api/v1/platform/tenant-invitations",
    { preHandler: [ISSUE, ABAC_ISSUE, STEPUP_ISSUE] },
    async (request, reply) => {
      const { userId } = actorOf(request);
      const body = parse(IssueInvitationRequest, request.body);
      const res = await service.issueInvitation(userId, {
        orgSlug: body.orgSlug,
        firstAdminEmail: body.firstAdminEmail,
        expiresInDays: body.expiresInDays,
      });
      return reply.code(201).send(res);
    },
  );

  // 3 — revoke a pending invitation (no step-up per §6). §4.1.
  app.delete(
    "/api/v1/platform/tenant-invitations/:id",
    { preHandler: [REVOKE, ABAC_REVOKE] },
    async (request) => {
      actorOf(request);
      const { id } = parse(InvitationParamsSchema, request.params);
      return service.revokeInvitation(id);
    },
  );
}

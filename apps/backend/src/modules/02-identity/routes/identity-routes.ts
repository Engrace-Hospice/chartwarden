// apps/backend/src/modules/02-identity/routes/identity-routes.ts — M2-T06 identity route
// inventory (M2 spec §4.1–4.2; proves the §7.1, §7.2, §7.5, §7.6 happy paths).
//
// The WardenX-specific `/api/v1/*` identity routes M2 owns as hand-written Fastify routes
// (the auth primitives — sign-in, 2FA enroll/verify §7.4, passkey enroll/login §7.3 — are
// Better-Auth-mounted at `/api/auth/*` by the vendor adapter in packages/auth, M2-T01; the
// step-up routes are M2-T05; the auditor-invite route is M3-owned per D4 — see §4.1):
//
//   GET    /api/v1/auth/memberships           list own memberships (pre-org)          §7.2
//   POST   /api/v1/auth/select-organization   bind the session to one org (one-time)  §7.2
//   POST   /api/v1/orgs/:id/invitations       invite a user to an org                 §7.1
//   POST   /api/v1/invitations/accept         consume an invite token → membership    §7.1
//   DELETE /api/v1/orgs/:id/invitations/:invId rescind a pending invite
//   GET    /api/v1/orgs/:id/members           list an org's memberships               §7.5
//   PATCH  /api/v1/orgs/:id/members/:mId       suspend / reinstate / re-scope          §7.5
//   DELETE /api/v1/orgs/:id/members/:mId       revoke a membership (reap its sessions) §7.5
//   POST   /api/v1/users/:id/deactivate       full offboard (disable creds everywhere)§7.5
//   POST   /api/v1/collaborators/invite       mint a per-patient magic-link           §7.6
//   POST   /api/v1/collaborators/consume      consume the link → scoped session       §7.6
//
// Every route sits BEHIND the REAL Authorization Contract (as of M3-T10): admin routes gate on
// the §4.7 permission keys via `requirePermission`, and the per-patient collaborator route on
// the `caseload_membership` ABAC predicate via `requireAbac` (both from @wardenx/auth, a
// foundation-helper package every module may consume). The M1 deny-stub forward-seam is retired.
// Every mutation is audited at `compliance` retention through the mandated audit() helper (the
// field denylist runs there — the invitee email is redacted). Org binding is server-side only:
// an admin route additionally asserts the session's bound org === the path org, so a token
// replay with an altered org cannot act cross-tenant (§7.12).
import type { AuditContext, AuditExecutor } from "@wardenx/audit";
import { requireAbac, requirePermission, requireSession } from "@wardenx/auth";
import { UnauthorizedError, ValidationError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  auditCollaboratorInvited,
  auditCollaboratorSessionStarted,
  auditInvitationRescinded,
  auditMembershipAccepted,
  auditMembershipRevoked,
  auditMembershipStatusChanged,
  auditUserDeactivated,
  auditUserInvited,
} from "../audit/identity-audit";
import {
  type Actor,
  type IdentityRouteDeps,
  LinkError,
  type MembershipRecord,
  type MembershipStatus,
  type MembershipView,
} from "../identity-ports";

const DEFAULT_COLLAB_TTL_SEC = 8 * 3600; // §7.6 — up to 8h

/** Spec §4.2 / §7.12 domain errors carried in the standard envelope (code + status). */
const noActiveMembership = () =>
  new WardenXError("NO_ACTIVE_MEMBERSHIP", "no active membership in the chosen org", 403);
const orgAlreadyBound = () =>
  new WardenXError("ORG_ALREADY_BOUND", "session already org-scoped; re-login to switch", 409);
const pendingInviteExists = () =>
  new WardenXError("PENDING_INVITE_EXISTS", "a pending invite already exists for this email", 409);
const lastAdminLockout = () =>
  new WardenXError(
    "LAST_ADMIN",
    "refusing to leave the org with zero active admins (platform_ops override required)",
    409,
  );

/** Map a store LinkError to the spec's HTTP code (§4.2 collaborators/consume, §7.12). */
function linkErrorToHttp(err: LinkError): WardenXError {
  if (err.kind === "used") return new WardenXError("LINK_ALREADY_USED", err.message, 409);
  if (err.kind === "verification_required")
    return new WardenXError("VERIFICATION_REQUIRED", err.message, 401);
  return new WardenXError("LINK_EXPIRED", err.message, 410);
}

/** Resolve the authenticated actor or fail closed (401 envelope). */
async function resolveActor(deps: IdentityRouteDeps, request: FastifyRequest): Promise<Actor> {
  const actor = await deps.actors.resolve(request);
  if (!actor) throw new UnauthorizedError();
  return actor;
}

/** Build the audit context for an identity event from the request + scope. */
function auditContextFor(
  request: FastifyRequest,
  scope: {
    organizationId: string | null;
    userId: string | null;
    actorKind?: AuditContext["actorKind"];
  },
): AuditContext {
  return {
    organizationId: scope.organizationId,
    userId: scope.userId,
    actorKind: scope.actorKind ?? "user",
    correlationId: request.context.correlationId,
    requestId: String(request.id),
    sourceIp: request.context.ip,
    userAgent: request.context.userAgent,
  };
}

const toView = (r: MembershipRecord): MembershipView => ({
  membershipId: r.membershipId,
  organizationId: r.organizationId,
  organizationName: r.organizationName,
  status: r.status,
  isAdmin: r.isAdmin,
  defaultLocationIds: r.defaultLocationIds,
});

/** Read a required string field from a request body (flat VALIDATION_FAILED on miss). */
function readString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`invalid ${field}`, [
      { field, code: "REQUIRED", message: `${field} is required` },
    ]);
  }
  return value;
}

/** Read an optional string[] field (defaults to []). */
function readStringArray(body: unknown, field: string): string[] {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ValidationError(`invalid ${field}`, [
      { field, code: "INVALID", message: `${field} must be an array of strings` },
    ]);
  }
  return value as string[];
}

/** Assert the acting admin's bound org matches the path org (server-side org binding, §7.12). */
function assertOrgMatch(request: FastifyRequest, pathOrgId: string): void {
  if (request.context.organizationId !== pathOrgId) {
    throw new WardenXError("FORBIDDEN", "admin actions are scoped to the bound org", 403);
  }
}

export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRouteDeps): void {
  const collabTtlSec = deps.collaboratorSessionTtlSec ?? DEFAULT_COLLAB_TTL_SEC;

  // --- §7.2 Traveling nurse: list memberships, then bind exactly one org ------------------
  app.get("/api/v1/auth/memberships", async (request) => {
    const actor = await resolveActor(deps, request);
    const rows = await deps.memberships.listForUser(actor.userId);
    return { memberships: rows.map(toView) };
  });

  app.post("/api/v1/auth/select-organization", async (request, reply) => {
    const actor = await resolveActor(deps, request);
    const organizationId = readString(request.body, "organizationId");
    if (actor.organizationId) throw orgAlreadyBound(); // one-time binding (§4.2)

    const membership = await deps.memberships.findActive(actor.userId, organizationId);
    if (!membership) throw noActiveMembership();

    const binding = await deps.sessions.bindOrganization({
      sessionId: actor.sessionId,
      organizationId,
      organizationName: membership.organizationName,
    });
    return reply.code(200).send(binding);
  });

  // --- §7.1 Invite & onboard a clinician -------------------------------------------------
  app.post("/api/v1/orgs/:id/invitations", async (request, reply) => {
    await requirePermission("member.invite")(request);
    const orgId = (request.params as { id: string }).id;
    assertOrgMatch(request, orgId);
    const actor = await resolveActor(deps, request);

    const email = readString(request.body, "email");
    const proposedRoleKeys = readStringArray(request.body, "proposedRoleKeys");
    const proposedDefaultLocationIds = readStringArray(request.body, "proposedDefaultLocationIds");
    const providerId = (request.body as Record<string, unknown>).proposedDefaultProviderEntityId;

    if (await deps.invitations.pendingExists(orgId, email)) throw pendingInviteExists();

    const orgName = request.context.attributes.organizationName;
    const created = await deps.invitations.create({
      organizationId: orgId,
      organizationName: typeof orgName === "string" ? orgName : "Organization",
      email,
      proposedRoleKeys,
      defaultLocationIds: proposedDefaultLocationIds,
      ...(typeof providerId === "string" ? { proposedProviderEntityId: providerId } : {}),
    });

    await auditUserInvited(
      deps.audit,
      auditContextFor(request, { organizationId: orgId, userId: actor.userId }),
      { invitationId: created.invitationId, organizationId: orgId, email },
    );
    // Token is emailed by the registered transactional sender — never returned in the body.
    return reply
      .code(201)
      .send({ invitationId: created.invitationId, expiresAt: created.expiresAt });
  });

  app.post("/api/v1/invitations/accept", async (request, reply) => {
    // Auth column `none`: the just-signed-up invitee (Better Auth) presents the token.
    const actor = await resolveActor(deps, request);
    const token = readString(request.body, "token");

    let detail: Awaited<ReturnType<typeof deps.invitations.consume>>;
    try {
      detail = await deps.invitations.consume(token); // atomic one-time consume (§7.12)
    } catch (err) {
      if (err instanceof LinkError) throw linkErrorToHttp(err);
      throw err;
    }

    const membership = await deps.memberships.create({
      userId: actor.userId,
      organizationId: detail.organizationId,
      organizationName: detail.organizationName,
      defaultLocationIds: [...detail.defaultLocationIds],
    });

    await auditMembershipAccepted(
      deps.audit,
      auditContextFor(request, { organizationId: detail.organizationId, userId: actor.userId }),
      {
        membershipId: membership.membershipId,
        organizationId: detail.organizationId,
        userId: actor.userId,
      },
    );
    // proposedRoleKeys are carried to M3 on accept (role attach is M3-owned, §7.1).
    return reply.code(200).send({
      membershipId: membership.membershipId,
      organizationId: detail.organizationId,
      status: membership.status,
    });
  });

  app.delete("/api/v1/orgs/:id/invitations/:invId", async (request, reply) => {
    await requirePermission("member.invite")(request);
    const { id: orgId, invId } = request.params as { id: string; invId: string };
    assertOrgMatch(request, orgId);
    const actor = await resolveActor(deps, request);

    const removed = await deps.invitations.rescind(invId);
    if (!removed) throw new WardenXError("NOT_FOUND", "invitation not found", 404);

    await auditInvitationRescinded(
      deps.audit,
      auditContextFor(request, { organizationId: orgId, userId: actor.userId }),
      { invitationId: invId, organizationId: orgId },
    );
    return reply.code(200).send({ rescinded: true });
  });

  // --- §7.5 Member lifecycle: list / suspend / revoke / deactivate -----------------------
  app.get("/api/v1/orgs/:id/members", async (request) => {
    await requirePermission("member.manage")(request);
    const orgId = (request.params as { id: string }).id;
    assertOrgMatch(request, orgId);
    const rows = await deps.memberships.listForOrg(orgId);
    return { members: rows.map(toView) };
  });

  app.patch("/api/v1/orgs/:id/members/:mId", async (request, reply) => {
    await requirePermission("member.manage")(request);
    const { id: orgId, mId } = request.params as { id: string; mId: string };
    assertOrgMatch(request, orgId);
    const actor = await resolveActor(deps, request);

    const membership = await deps.memberships.get(mId);
    if (!membership || membership.organizationId !== orgId) {
      throw new WardenXError("NOT_FOUND", "membership not found", 404);
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const nextStatus = body.status as MembershipStatus | undefined;
    if (nextStatus !== undefined && !["active", "suspended"].includes(nextStatus)) {
      throw new ValidationError("invalid status", [
        { field: "status", code: "INVALID", message: "status must be 'active' or 'suspended'" },
      ]);
    }

    let updated = membership;
    if (nextStatus && nextStatus !== membership.status) {
      // Last-admin lockout guard: suspending the last active admin is refused (§6).
      if (nextStatus === "suspended" && membership.isAdmin) {
        const admins = await deps.memberships.activeAdminCount(orgId);
        if (admins <= 1) throw lastAdminLockout();
      }
      const from = membership.status;
      updated = await deps.memberships.setStatus(mId, nextStatus);
      await auditMembershipStatusChanged(
        deps.audit,
        auditContextFor(request, { organizationId: orgId, userId: actor.userId }),
        { membershipId: mId, organizationId: orgId, from, to: nextStatus },
      );
    }

    if (body.defaultLocationIds !== undefined) {
      const scope = readStringArray(body, "defaultLocationIds");
      updated = await deps.memberships.setDefaultScope(mId, scope);
    }

    return reply.code(200).send(toView(updated));
  });

  app.delete("/api/v1/orgs/:id/members/:mId", async (request, reply) => {
    await requirePermission("member.manage")(request);
    const { id: orgId, mId } = request.params as { id: string; mId: string };
    assertOrgMatch(request, orgId);
    const actor = await resolveActor(deps, request);

    const membership = await deps.memberships.get(mId);
    if (!membership || membership.organizationId !== orgId) {
      throw new WardenXError("NOT_FOUND", "membership not found", 404);
    }
    if (membership.isAdmin) {
      const admins = await deps.memberships.activeAdminCount(orgId);
      if (admins <= 1) throw lastAdminLockout(); // last-admin lockout guard (§6)
    }

    await deps.memberships.setStatus(mId, "revoked");
    // Revoking a membership terminates that user's sessions in this org within seconds (§7.5).
    await deps.sessions.revokeForMembership(mId);
    await auditMembershipRevoked(
      deps.audit,
      auditContextFor(request, { organizationId: orgId, userId: actor.userId }),
      { membershipId: mId, organizationId: orgId },
    );
    return reply.code(200).send({ revoked: true });
  });

  app.post("/api/v1/users/:id/deactivate", async (request, reply) => {
    // §4.7: org_admin (own org) or platform_ops (any) hold `user.deactivate`; the resolver
    // grants it per the assigned role templates.
    await requirePermission("user.deactivate")(request);
    const userId = (request.params as { id: string }).id;
    const actor = await resolveActor(deps, request);
    const reason = readString(request.body, "reason");

    await deps.users.deactivate(userId, reason); // disable credentials everywhere
    await deps.sessions.revokeAllForUser(userId); // reap all sessions (§7.5)
    await auditUserDeactivated(
      deps.audit,
      auditContextFor(request, {
        organizationId: request.context.organizationId,
        userId: actor.userId,
      }),
      { userId, reason },
    );
    return reply.code(200).send({ deactivated: true });
  });

  // --- §7.6 External collaborator: mint a per-patient link, then consume it ---------------
  app.post("/api/v1/collaborators/invite", async (request, reply) => {
    // staff-class session; the patient must be on the actor's caseload (§4.7 collaborator.invite,
    // ABAC: caseload_membership). The predicate is M3-owned and resolves through the M5/M17
    // CaseloadProvider seam (deny-by-default until that provider registers at boot).
    await requireSession()(request);
    await requireAbac("collaborator.invite", "caseload_membership", {
      getTarget: (req) => {
        const patientId = (req.body as { patientId?: unknown } | null)?.patientId;
        return typeof patientId === "string" ? { patientId } : {};
      },
    })(request);
    const actor = await resolveActor(deps, request);
    if (!actor.organizationId || !actor.membershipId) {
      throw new WardenXError("FORBIDDEN", "an org-bound staff session is required", 403);
    }
    const patientId = readString(request.body, "patientId");

    const link = await deps.collaborators.create({
      organizationId: actor.organizationId,
      patientId,
      invitedByMembershipId: actor.membershipId,
    });
    await auditCollaboratorInvited(
      deps.audit,
      auditContextFor(request, { organizationId: actor.organizationId, userId: actor.userId }),
      { linkId: link.linkId, organizationId: actor.organizationId, patientId },
    );
    // Token delivered out-of-band (email/SMS via the transactional sender) — never in body.
    return reply.code(201).send({ linkId: link.linkId, expiresAt: link.expiresAt });
  });

  app.post("/api/v1/collaborators/consume", async (request, reply: FastifyReply) => {
    // Auth column `none`: the collaborator presents the one-time token (§4.2).
    const token = readString(request.body, "token");
    let scope: Awaited<ReturnType<typeof deps.collaborators.consume>>;
    try {
      scope = await deps.collaborators.consume(token);
    } catch (err) {
      if (err instanceof LinkError) throw linkErrorToHttp(err);
      throw err;
    }

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + collabTtlSec * 1000).toISOString();
    await auditCollaboratorSessionStarted(
      deps.audit,
      auditContextFor(request, {
        organizationId: scope.organizationId,
        userId: null,
        actorKind: "external_collaborator",
      }),
      { sessionId, organizationId: scope.organizationId, patientId: scope.patientId },
    );
    // Production sets the external_collaborator session cookie here; scope is exactly 1 patient.
    return reply.code(200).send({
      sessionClass: "external_collaborator",
      scope: { patientId: scope.patientId },
      expiresAt,
    });
  });
}

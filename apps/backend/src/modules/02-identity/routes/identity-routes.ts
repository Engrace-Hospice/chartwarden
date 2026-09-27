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
import {
  requireAbac,
  requirePermission,
  requireSession,
  resolveActorPermissions,
} from "@wardenx/auth";
import { UnauthorizedError, ValidationError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  auditCollaboratorInvited,
  auditCollaboratorSessionStarted,
  auditInvitationRescinded,
  auditMembershipAccepted,
  auditMembershipRevoked,
  auditMembershipStatusChanged,
  auditRolesAttachedOnAccept,
  auditUserDeactivated,
  auditUserInvited,
} from "../audit/identity-audit";
import {
  type Actor,
  type IdentityRouteDeps,
  type InvitationDetail,
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
const organizationNotActive = () =>
  new WardenXError(
    "ORGANIZATION_NOT_ACTIVE",
    "this organization is not active; sign-in is refused (§11 D19 auth-time enforcement)",
    403,
  );
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

/**
 * The org's display name, for the invitation the invitee actually reads (TASK-030).
 *
 * Both invitation routes used to take this from `request.context.attributes.organizationName` and
 * fall back to the literal `"Organization"`. Nothing has ever written that attribute (F-030), so the
 * fallback was not a fallback — it was the only branch. Every WardenX invitation row was stored with
 * the name `Organization`, the pre-auth `GET /invitations/:token` preview served that back to the
 * invitee's browser, and the email said "You've been invited to join your organization".
 *
 * Resolved instead from the INVITER's own active membership in the org they are inviting into. They
 * necessarily have one: `member.invite` was granted in this org and `assertOrgMatch` has already
 * bound the route's `:id` to the session's org. That makes the lookup org-scoped by construction —
 * no cross-tenant read, and no new dependency; the same `findActive` the `/auth/context` projection
 * already reads the name through.
 */
async function organizationNameFor(
  deps: IdentityRouteDeps,
  userId: string,
  organizationId: string,
): Promise<string | undefined> {
  const membership = await deps.memberships.findActive(userId, organizationId);
  // Undefined rather than a placeholder: the callers decide what an unresolvable name means, and
  // neither of them may fail a durably-recorded invite over a display string.
  return membership?.organizationName || undefined;
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

/** Publish through `deps.outbox` if bound — record-only until a consumer is declared. */
function publishM2(
  deps: IdentityRouteDeps,
  input: {
    eventName: string;
    payload: Record<string, unknown>;
    organizationId: string | null;
    aggregateKind: string;
    aggregateId: string;
  },
): Promise<void> {
  return deps.outbox?.publish(input) ?? Promise.resolve();
}

const toView = (r: MembershipRecord): MembershipView => ({
  membershipId: r.membershipId,
  userId: r.userId,
  organizationId: r.organizationId,
  organizationName: r.organizationName,
  status: r.status,
  isAdmin: r.isAdmin,
  defaultLocationIds: r.defaultLocationIds,
  displayName: r.displayName ?? null,
  email: r.email ?? null,
  lastLoginAt: r.lastLoginAt ?? null,
  accountStatus: r.accountStatus ?? null,
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

/**
 * TASK-030 — best-effort email delivery + the admin-visible link fallback. No vendor sender is wired
 * yet (M36's transport no-ops in production, logs in dev), so a delivery failure must never surface
 * as a 5xx on a request whose invite was already durably recorded; the returned `inviteUrl` — echoed
 * to the inviting admin, who already holds `member.invite` — is the fallback until one is.
 */
async function deliverInvite(
  deps: IdentityRouteDeps,
  organizationName: string | undefined,
  email: string,
  token: string,
): Promise<string | undefined> {
  const inviteUrl = deps.webAppBaseUrl
    ? `${deps.webAppBaseUrl.replace(/\/$/, "")}/invite/${token}`
    : undefined;
  if (deps.emailTransport && inviteUrl) {
    const orgName = organizationName ?? "your organization";
    try {
      await deps.emailTransport.send({
        to: email,
        subject: "You're invited to WardenX",
        text: `You've been invited to join ${orgName} on WardenX. Accept your invitation using this link (it expires in 72 hours):\n\n${inviteUrl}\n\nIf you weren't expecting this, you can ignore this email.`,
      });
    } catch {
      // Swallow: see the doc comment above.
    }
  }
  return inviteUrl;
}

export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRouteDeps): void {
  const collabTtlSec = deps.collaboratorSessionTtlSec ?? DEFAULT_COLLAB_TTL_SEC;

  // --- §7.2 Traveling nurse: list memberships, then bind exactly one org ------------------
  app.get("/api/v1/auth/memberships", async (request) => {
    const actor = await resolveActor(deps, request);
    const rows = await deps.memberships.listForUser(actor.userId);
    return { memberships: rows.map(toView) };
  });

  // --- Actor context: the app shell's role/membership enrichment surface (M2↔M3 seam, FB-T15) ---
  // Read-only projection of the authenticated actor for the web shell: identity + the active
  // membership + the M3-resolved role keys + the effective permission keys (Role-Home / nav
  // gating). The roles come from the actor context the authenticate hook fills via the M2↔M3
  // ActorEnrichment seam; the permissions come through the SAME resolver `requirePermission`
  // gates on, so the shell only ever REFLECTS server-side grants — the server stays the sole
  // enforcer (no new authz). A pre-org session resolves with no org/membership/roles/permissions;
  // unauthenticated fails closed (401), matching `/auth/memberships`.
  app.get("/api/v1/auth/context", async (request) => {
    const actor = await resolveActor(deps, request);
    const orgId = actor.organizationId;
    const membership = orgId ? await deps.memberships.findActive(actor.userId, orgId) : null;
    const permissions = orgId
      ? [...(await resolveActorPermissions({ organizationId: orgId, userId: actor.userId }))]
      : [];
    return {
      userId: actor.userId,
      organizationId: orgId,
      organizationName: membership?.organizationName ?? null,
      membershipId: membership?.membershipId ?? null,
      displayName: membership?.displayName ?? null,
      roles: [...actor.roles],
      isAdmin: membership?.isAdmin ?? false,
      permissions,
    };
  });

  app.post("/api/v1/auth/select-organization", async (request, reply) => {
    const actor = await resolveActor(deps, request);
    const organizationId = readString(request.body, "organizationId");
    if (actor.organizationId) throw orgAlreadyBound(); // one-time binding (§4.2)

    const membership = await deps.memberships.findActive(actor.userId, organizationId);
    if (!membership) throw noActiveMembership();

    if (deps.organizations) {
      const status = await deps.organizations.getStatus(organizationId);
      if (status !== null && status !== "active") throw organizationNotActive();
    }

    const binding = await deps.sessions.bindOrganization({
      sessionId: actor.sessionId,
      organizationId,
      organizationName: membership.organizationName,
    });
    await publishM2(deps, {
      eventName: "m2.session.created",
      payload: { sessionId: actor.sessionId, userId: actor.userId, organizationId },
      organizationId,
      aggregateKind: "session",
      aggregateId: actor.sessionId,
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

    const orgName = await organizationNameFor(deps, actor.userId, orgId);
    const created = await deps.invitations.create({
      organizationId: orgId,
      organizationName: orgName ?? "Organization",
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
    // Email is deliberately NOT in the payload: the audit trail redacts it through the field
    // denylist, and an outbox row has no equivalent protection.
    await publishM2(deps, {
      eventName: "m2.user.invited",
      payload: { invitationId: created.invitationId, organizationId: orgId },
      organizationId: orgId,
      aggregateKind: "organization_invitation",
      aggregateId: created.invitationId,
    });
    const inviteUrl = await deliverInvite(deps, orgName, email, created.token);
    return reply.code(201).send({
      invitationId: created.invitationId,
      expiresAt: created.expiresAt,
      ...(inviteUrl ? { inviteUrl } : {}),
    });
  });

  // TASK-030 — the org's invitation roster (Staff Management pending-invite list).
  app.get("/api/v1/orgs/:id/invitations", async (request) => {
    await requirePermission("member.invite")(request);
    const orgId = (request.params as { id: string }).id;
    assertOrgMatch(request, orgId);
    return { invitations: await deps.invitations.list(orgId) };
  });

  // TASK-030 — re-mint a pending invite's token + expiry (invalidates the prior link) and re-deliver it.
  app.post("/api/v1/orgs/:id/invitations/:invId/resend", async (request, reply) => {
    await requirePermission("member.invite")(request);
    const { id: orgId, invId } = request.params as { id: string; invId: string };
    assertOrgMatch(request, orgId);
    const actor = await resolveActor(deps, request);

    const roster = await deps.invitations.list(orgId);
    const target = roster.find((i) => i.invitationId === invId);
    if (!target) throw new WardenXError("NOT_FOUND", "invitation not found", 404);

    const reminted = await deps.invitations.resend(invId);
    if (!reminted) {
      throw new WardenXError("NOT_FOUND", "invitation is no longer pending", 404);
    }
    await auditUserInvited(
      deps.audit,
      auditContextFor(request, { organizationId: orgId, userId: actor.userId }),
      { invitationId: invId, organizationId: orgId, email: target.email },
    );
    await publishM2(deps, {
      eventName: "m2.user.invited",
      payload: { invitationId: invId, organizationId: orgId },
      organizationId: orgId,
      aggregateKind: "organization_invitation",
      aggregateId: invId,
    });
    const orgName = await organizationNameFor(deps, actor.userId, orgId);
    const inviteUrl = await deliverInvite(deps, orgName, target.email, reminted.token);
    return reply.code(200).send({
      invitationId: reminted.invitationId,
      expiresAt: reminted.expiresAt,
      ...(inviteUrl ? { inviteUrl } : {}),
    });
  });

  // TASK-030 — pre-auth preview of a still-pending token's target, so the invitee's browser can
  // pre-fill a sign-up form BEFORE an account (and therefore a session) exists to call `accept` through.
  app.get("/api/v1/invitations/:token", async (request) => {
    const { token } = request.params as { token: string };
    let detail: InvitationDetail;
    try {
      detail = await deps.invitations.peek(token);
    } catch (err) {
      if (err instanceof LinkError) throw linkErrorToHttp(err);
      throw err;
    }
    return { email: detail.email, organizationName: detail.organizationName };
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
    await publishM2(deps, {
      eventName: "m2.membership.accepted",
      payload: {
        membershipId: membership.membershipId,
        organizationId: detail.organizationId,
        userId: actor.userId,
      },
      organizationId: detail.organizationId,
      aggregateKind: "membership",
      aggregateId: membership.membershipId,
    });

    // F-097 — the §D3 handshake, performed. This line used to be the comment
    // "proposedRoleKeys are carried to M3 on accept (role attach is M3-owned, §7.1)" followed by a
    // return: the keys reached here and went nowhere, so every invitation produced a membership with no
    // grants at all. `m2.membership.accepted` now publishes above (M2's catalog gap, #205), but no
    // consumer is declared on it yet — the role attach below stays the real, synchronous mechanism.
    //
    // AFTER the membership audit, deliberately: the membership exists whether or not the grants land,
    // and an attach failure must not roll back an invitation that has already been atomically consumed
    // (the token is one-time — a thrown accept would leave the invitee with no membership and no way to
    // retry). A failure is audited and reported, not swallowed and not escalated into losing the seat.
    const rolesAttached = deps.roleAttacher
      ? await deps.roleAttacher.attach({
          organizationId: detail.organizationId,
          membershipId: membership.membershipId,
          roleKeys: detail.proposedRoleKeys,
          grantedByUserId: actor.userId,
        })
      : null;

    if (
      rolesAttached &&
      (rolesAttached.attached.length > 0 || rolesAttached.unresolved.length > 0)
    ) {
      await auditRolesAttachedOnAccept(
        deps.audit,
        auditContextFor(request, { organizationId: detail.organizationId, userId: actor.userId }),
        {
          membershipId: membership.membershipId,
          organizationId: detail.organizationId,
          attached: rolesAttached.attached,
          unresolved: rolesAttached.unresolved,
        },
      );
    }

    // #138/F-060/F-116 — the day-one dashboard seed. Same placement rule as the role attach above:
    // AFTER the membership exists, best-effort, never rolling back an already-consumed one-time
    // invitation token over a reporting-side failure. Idempotent (report_definition_system_org_base_uq,
    // migration 0248) — every accept for this org after the first is a cheap no-op.
    if (deps.dashboardSeeder) {
      await deps.dashboardSeeder.ensureSystemDashboards({
        organizationId: detail.organizationId,
        userId: actor.userId,
        ownerMembershipId: membership.membershipId,
      });
    }

    // `rolesAttached` is on the wire so the caller can tell the three states apart: roles granted, roles
    // REQUESTED BUT UNRESOLVABLE (the org has no such role — which is every key in a freshly provisioned
    // tenant, since nothing materializes ROLE_TEMPLATES), and no attacher bound at all. Reporting only
    // the membership id, as before, is what made an invitation that granted nothing indistinguishable
    // from one that worked.
    return reply.code(200).send({
      membershipId: membership.membershipId,
      organizationId: detail.organizationId,
      status: membership.status,
      rolesAttached,
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
    await publishM2(deps, {
      eventName: "m2.invitation.rescinded",
      payload: { invitationId: invId, organizationId: orgId },
      organizationId: orgId,
      aggregateKind: "organization_invitation",
      aggregateId: invId,
    });
    return reply.code(200).send({ rescinded: true });
  });

  // --- §7.5 Member lifecycle: list / suspend / revoke / deactivate -----------------------
  app.get("/api/v1/orgs/:id/members", async (request) => {
    await requirePermission("member.manage")(request);
    const orgId = (request.params as { id: string }).id;
    assertOrgMatch(request, orgId);
    // Optional `q` narrows the roster (Global Search staff facet, FB-T11). Server-side so the
    // filter stays under RLS; the permission gate is unchanged (still member.manage).
    const rawQ = (request.query as { q?: unknown } | null)?.q;
    const q = typeof rawQ === "string" && rawQ.trim() ? rawQ.trim() : undefined;
    const rows = await deps.memberships.listForOrg(orgId, q);
    // `pendingInvitations` backs the Staff Management "pending invites" KPI (FB-T12). It reflects
    // the whole org regardless of the `q` roster narrowing, so the KPI stays stable while filtering.
    const pendingInvitations = await deps.invitations.pendingCount(orgId);
    return { members: rows.map(toView), pendingInvitations };
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
      // Mirrors IDENTITY_AUDIT_EVENTS' own from/to → eventName mapping (audit/identity-audit.ts).
      const eventName =
        nextStatus === "suspended"
          ? "m2.membership.suspended"
          : from === "suspended" && nextStatus === "active"
            ? "m2.membership.reinstated"
            : "m2.membership.updated";
      await publishM2(deps, {
        eventName,
        payload: { membershipId: mId, organizationId: orgId, from, to: nextStatus },
        organizationId: orgId,
        aggregateKind: "membership",
        aggregateId: mId,
      });
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
    await publishM2(deps, {
      eventName: "m2.membership.revoked",
      payload: { membershipId: mId, organizationId: orgId },
      organizationId: orgId,
      aggregateKind: "membership",
      aggregateId: mId,
    });
    return reply.code(200).send({ revoked: true });
  });

  // --- §3.7 Named approval authority (GAP-043) ------------------------------------------
  // The ENTRANCE for `membership_elevated_approval`. M27's §4.7 `cost_report_approver_for_provider`
  // predicate reads this designation through M2's `ElevatedApprovalReader` seam; without a way to make
  // one, wiring that read would have left the approver gate denying for a new reason instead of the old
  // one. Gated on `member.manage` — the same permission every sibling member-lifecycle route uses, since
  // designating a signatory is a membership-administration act. (Deliberately NOT step-up gated: the
  // sibling routes are not, and adding a ceremony here only would be an inconsistency, not a control.
  // The step-up requirement lives where the spec puts it — on M27's submit/reopen actions themselves.)
  const requireElevatedApprovals = () => {
    const service = deps.elevatedApprovals;
    if (!service) throw new WardenXError("NOT_FOUND", "not found", 404);
    return service;
  };

  /** Resolve + validate the target membership belongs to this org (no cross-tenant designation). */
  async function targetMembership(request: FastifyRequest, orgId: string, mId: string) {
    assertOrgMatch(request, orgId);
    const membership = await deps.memberships.get(mId);
    if (!membership || membership.organizationId !== orgId) {
      throw new WardenXError("NOT_FOUND", "membership not found", 404);
    }
    return membership;
  }

  app.get("/api/v1/orgs/:id/members/:mId/elevated-approvals", async (request) => {
    await requirePermission("member.manage")(request);
    const service = requireElevatedApprovals();
    const { id: orgId, mId } = request.params as { id: string; mId: string };
    await targetMembership(request, orgId, mId);
    // Live AND revoked, newest first — the point of the register is that a surveyor can see who held
    // the authority when, not just who holds it today.
    return { grants: await service.list(orgId, mId) };
  });

  app.post("/api/v1/orgs/:id/members/:mId/elevated-approvals", async (request, reply) => {
    await requirePermission("member.manage")(request);
    const service = requireElevatedApprovals();
    const { id: orgId, mId } = request.params as { id: string; mId: string };
    await targetMembership(request, orgId, mId);
    const actor = await resolveActor(deps, request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const kind = readString(body, "approvalKind");
    const grantReason = readString(body, "grantReason");
    if (grantReason.trim().length < 10) {
      throw new ValidationError("grantReason too short", [
        {
          field: "grantReason",
          code: "TOO_SHORT",
          message: "grantReason must be at least 10 characters (the CHECK constraint agrees)",
        },
      ]);
    }
    // The granter is a MEMBERSHIP, not a user: the FK targets `membership`, and an authority granted by
    // "some user" would not say which of their org memberships acted.
    if (!actor.membershipId) throw new UnauthorizedError();
    const grant = await service.grant({
      organizationId: orgId,
      membershipId: mId,
      kind,
      grantedByMembershipId: actor.membershipId,
      grantReason,
    });
    return reply.code(201).send(grant);
  });

  app.delete("/api/v1/orgs/:id/members/:mId/elevated-approvals/:kind", async (request, reply) => {
    await requirePermission("member.manage")(request);
    const service = requireElevatedApprovals();
    const {
      id: orgId,
      mId,
      kind,
    } = request.params as {
      id: string;
      mId: string;
      kind: string;
    };
    await targetMembership(request, orgId, mId);
    const actor = await resolveActor(deps, request);
    const revokedReason = readString(request.body, "revokedReason");
    if (revokedReason.trim().length < 10) {
      throw new ValidationError("revokedReason too short", [
        {
          field: "revokedReason",
          code: "TOO_SHORT",
          message: "revokedReason must be at least 10 characters (the CHECK constraint agrees)",
        },
      ]);
    }
    if (!actor.membershipId) throw new UnauthorizedError();
    const revoked = await service.revoke({
      organizationId: orgId,
      membershipId: mId,
      kind,
      revokedByMembershipId: actor.membershipId,
      revokedReason,
    });
    return reply.code(200).send(revoked);
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
    await publishM2(deps, {
      eventName: "m2.user.deactivated",
      payload: { userId, reason },
      organizationId: request.context.organizationId,
      aggregateKind: "user",
      aggregateId: userId,
    });
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
    await publishM2(deps, {
      eventName: "m2.collaborator.invited",
      payload: { linkId: link.linkId, organizationId: actor.organizationId, patientId },
      organizationId: actor.organizationId,
      aggregateKind: "collaborator_link",
      aggregateId: link.linkId,
    });
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
    await publishM2(deps, {
      eventName: "m2.collaborator.session_started",
      payload: { sessionId, organizationId: scope.organizationId, patientId: scope.patientId },
      organizationId: scope.organizationId,
      aggregateKind: "session",
      aggregateId: sessionId,
    });
    // Production sets the external_collaborator session cookie here; scope is exactly 1 patient.
    return reply.code(200).send({
      sessionClass: "external_collaborator",
      scope: { patientId: scope.patientId },
      expiresAt,
    });
  });
}

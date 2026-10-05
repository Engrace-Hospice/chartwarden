// apps/backend/src/modules/03-authorization/routes/authz-routes.ts — M3-T08 the Module 3
// route inventory (M3 spec §4.3–4.4; the §6 meta-permission matrix; the §7.4–7.6 workflows).
//
// These are M3's OWN routes — the role catalog + assignment surface, the break-glass console,
// and the auditor-engagement console — each gated by a §6 META-permission through the REAL
// Authorization Contract (`requirePermission` / `requireSession` from @wardenx/auth, M3-T05),
// not a deny-stub: M3 is where the contract goes live. The §2.2 pipeline runs
// authenticate → requirePermission (RBAC) → handler; the handler mutates M3's org-scoped
// tables (in production, inside `withOrgContext` so RLS is the backstop) and audits the change
// through the mandated audit() helper.
//
// Anti-escalation (§6, Security Hardening §6): an admin may not grant a permission they do not
// themselves hold, nor strip a `system_locked` role below its CoP floor. Both are enforced
// server-side here (the floor in the store via @wardenx/auth `floorViolations`, the
// privilege-escalation guard against the actor's own effective permission set).
//
// Every body + path param is validated at the boundary against `./authz-typebox` (the M24/M30
// `parse(...)` precedent) BEFORE it reaches a store, so an off-vocabulary `role.category` or a
// non-uuid `target_patient_id` is a 422 here rather than a pgEnum/uuid cast failure at the INSERT.
// Validation is deliberately ordered AFTER the §6 meta-permission preHandler and after each
// route's existing existence lookup, so the §9.3 IDOR semantics are unchanged: an unauthorized
// actor still sees 403 (never 422) and an authorized actor still sees 404 for an absent object.
import type { AuditContext } from "@wardenx/audit";
import {
  allPermissionMirrorRows,
  isTenantRoleReserved,
  requirePermission,
  requireSession,
} from "@wardenx/auth";
import {
  ForbiddenError,
  type HttpRequestContext,
  UnauthorizedError,
  ValidationError,
  WardenXError,
} from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  auditAuditorEnrolled,
  auditBreakGlassCosignRefused,
  auditBreakGlassCosigned,
  auditBreakGlassInvoked,
  auditBreakGlassRevoked,
  auditEngagementCreated,
  auditEngagementUpdated,
  auditEscalationBlocked,
  auditRoleAssigned,
  auditRoleCreated,
  auditRoleDeleted,
  auditRoleRevoked,
  auditRoleUpdated,
} from "../audit/authz-audit";
import {
  type AuthzRouteDeps,
  BreakGlassCosignError,
  type BreakGlassView,
  RoleLockedError,
} from "../authz-ports";
import {
  AssignRoleBody,
  BreakGlassIdParams,
  CreateEngagementBody,
  CreateRoleBody,
  EngagementIdParams,
  EnrollAuditorBody,
  InvokeBreakGlassBody,
  MembershipIdParams,
  MembershipRoleParams,
  RoleIdParams,
  UpdateEngagementBody,
  UpdateRoleBody,
  parse,
} from "./authz-typebox";

const DEFAULT_BREAK_GLASS_TTL_SEC = 4 * 3600; // §3.5 D1 — default +4h time-box.

/** A guard wrapper so a @wardenx/auth GuardHandler is a Fastify preHandler. */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Build the audit context for an M3 event from the request + scope. */
function auditContextFor(request: FastifyRequest): AuditContext {
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

/** The org-scoped actor (org binding is server-side: the context, never the body). */
function actorOf(ctx: HttpRequestContext): { organizationId: string; userId: string } {
  if (!ctx.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** Map a store-level RoleLockedError onto the spec's HTTP code (409). */
function roleLockedToHttp(err: RoleLockedError): WardenXError {
  return new WardenXError("ROLE_LOCKED", err.message, 409);
}

/** Map a refused break-glass co-signature onto 409 (§7.4), preserving which guard fired. */
function cosignRefusedToHttp(err: BreakGlassCosignError): WardenXError {
  return new WardenXError(
    err.kind === "self_cosign" ? "BREAKGLASS_SELF_COSIGN" : "BREAKGLASS_NOT_PENDING",
    err.message,
    409,
  );
}

const notFound = (what: string) => new WardenXError("NOT_FOUND", `${what} not found`, 404);
/** GAP-003/GAP-096 — platform authority is neither mintable nor assignable through a tenant's role
 *  surface. Operators grant it out of band (`bun run db:platform-role`, OPS_RUNBOOK §16.5). */
const reservedRole = () =>
  new WardenXError(
    "RESERVED_ROLE",
    "platform role keys (platform_*, ai_safety_owner) and the platform_staff category are reserved to the platform",
    422,
  );

export function registerAuthorizationRoutes(app: FastifyInstance, deps: AuthzRouteDeps): void {
  const breakGlassTtlSec = deps.breakGlassTtlSec ?? DEFAULT_BREAK_GLASS_TTL_SEC;

  /** Anti-escalation (§6): refuse + audit if the actor grants a permission they lack. */
  async function assertNoEscalation(
    request: FastifyRequest,
    organizationId: string,
    userId: string,
    proposedKeys: readonly string[],
  ): Promise<void> {
    const held = await deps.effectivePermissions({ organizationId, userId });
    const escalated = proposedKeys.find((k) => !held.has(k));
    if (escalated) {
      await auditEscalationBlocked(deps.audit, auditContextFor(request), {
        attemptedPermission: escalated,
      });
      throw new ForbiddenError(`cannot grant permission '${escalated}' you do not hold`);
    }
  }

  // --- §6 role catalog (read) -------------------------------------------------------------
  app.get(
    "/api/v1/permissions",
    { preHandler: [requirePermission("role.read") as PreHandler] },
    async () => ({ permissions: allPermissionMirrorRows() }),
  );

  app.get(
    "/api/v1/roles",
    { preHandler: [requirePermission("role.read") as PreHandler] },
    async (request) => {
      const { organizationId } = actorOf(request.context);
      return { roles: await deps.roles.listForOrg(organizationId) };
    },
  );

  // --- §7.6 tenant customizes the catalog -------------------------------------------------
  app.post(
    "/api/v1/roles",
    { preHandler: [requirePermission("role.manage") as PreHandler] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request.context);
      const body = parse(CreateRoleBody, request.body);
      const permissionKeys = body.permissionKeys ?? [];
      // GAP-003: platform authority (`platform_*` keys, `platform_staff`) lives only on platform-owned
      // rows. Refused before anti-escalation, which a zero-permission spoof passes trivially. The
      // enrichment reader and the migration 0318 CHECK enforce the same rule below this route.
      if (isTenantRoleReserved(body)) throw reservedRole();

      await assertNoEscalation(request, organizationId, userId, permissionKeys);

      const role = await deps.roles.createCustom({
        organizationId,
        key: body.key,
        name: body.name,
        category: body.category,
        // Absent → the `role.scope_level` column default; never a widened grant.
        scopeLevel: body.scopeLevel ?? "location",
        clonedFromKey: body.clonedFromKey,
        permissionKeys,
      });
      await auditRoleCreated(deps.audit, auditContextFor(request), {
        roleId: role.roleId,
        roleKey: role.key,
        clonedFrom: body.clonedFromKey,
      });
      deps.rbacInvalidation?.invalidateOrg(organizationId); // §2.5 — a new role is grantable now
      return reply.code(201).send(role);
    },
  );

  app.patch(
    "/api/v1/roles/:id",
    { preHandler: [requirePermission("role.manage") as PreHandler] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request.context);
      const { id: roleId } = parse(RoleIdParams, request.params);
      const existing = await deps.roles.get(roleId);
      if (!existing) throw notFound("role");
      // A tenant row carrying a reserved key predates migration 0318, whose NOT VALID CHECK refuses any
      // new tuple for it — an UPDATE would surface as a raw 23514. It confers nothing; delete it instead.
      if (existing.organizationId !== null && isTenantRoleReserved(existing)) throw reservedRole();

      const body = parse(UpdateRoleBody, request.body);
      const patch: { name?: string; enabled?: boolean; permissionKeys?: string[] } = {};
      const changedFields: string[] = [];
      if (body.name !== undefined) {
        patch.name = body.name;
        changedFields.push("name");
      }
      if (body.enabled !== undefined) {
        patch.enabled = body.enabled;
        changedFields.push("enabled");
      }
      // Presence, not truthiness: `permissionKeys: []` is a meaningful strip-to-nothing edit (the
      // §3.4.1 floor check in the store is what refuses it for a system_locked role).
      if (body.permissionKeys !== undefined) {
        patch.permissionKeys = body.permissionKeys;
        changedFields.push("permissionKeys");
        await assertNoEscalation(request, organizationId, userId, patch.permissionKeys);
      }

      let updated: Awaited<ReturnType<typeof deps.roles.update>>;
      try {
        updated = await deps.roles.update(roleId, patch);
      } catch (err) {
        if (err instanceof RoleLockedError) throw roleLockedToHttp(err);
        throw err;
      }
      await auditRoleUpdated(deps.audit, auditContextFor(request), {
        roleId: updated.roleId,
        roleKey: updated.key,
        changedFields,
      });
      // §2.5 — an edited permission set must drop every cached actor set in the org immediately.
      deps.rbacInvalidation?.invalidateOrg(organizationId);
      return reply.code(200).send(updated);
    },
  );

  app.delete(
    "/api/v1/roles/:id",
    { preHandler: [requirePermission("role.manage") as PreHandler] },
    async (request, reply) => {
      const { organizationId } = actorOf(request.context);
      const { id: roleId } = parse(RoleIdParams, request.params);
      const existing = await deps.roles.get(roleId);
      if (!existing) throw notFound("role");
      try {
        await deps.roles.delete(roleId);
      } catch (err) {
        if (err instanceof RoleLockedError) throw roleLockedToHttp(err);
        throw err;
      }
      await auditRoleDeleted(deps.audit, auditContextFor(request), {
        roleId: existing.roleId,
        roleKey: existing.key,
      });
      deps.rbacInvalidation?.invalidateOrg(organizationId); // §2.5 — grants on it are void now
      return reply.code(200).send({ deleted: true });
    },
  );

  // --- §6 role assignment -----------------------------------------------------------------
  app.get(
    "/api/v1/memberships/:id/roles",
    { preHandler: [requirePermission("role.read") as PreHandler] },
    async (request) => {
      actorOf(request.context);
      const { id: membershipId } = parse(MembershipIdParams, request.params);
      return { roles: await deps.membershipRoles.listForMembership(membershipId) };
    },
  );

  app.post(
    "/api/v1/memberships/:id/roles",
    { preHandler: [requirePermission("role.assign") as PreHandler] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request.context);
      const { id: membershipId } = parse(MembershipIdParams, request.params);
      const body = parse(AssignRoleBody, request.body);

      const role = await deps.roles.get(body.roleId);
      if (!role) throw notFound("role");
      // GAP-003/GAP-096: a platform-owned reserved role is visible to every tenant, and anti-escalation
      // only compares permission keys, so it cannot stand in for this check. Platform authority is
      // granted out of band (`bun run db:platform-role`), never through a tenant's assignment surface.
      if (isTenantRoleReserved(role)) throw reservedRole();
      // Anti-escalation: an admin may not confer permissions they do not themselves hold.
      await assertNoEscalation(request, organizationId, userId, role.permissionKeys);

      const expiresAt = body.expiresAt ?? null;
      const grant = await deps.membershipRoles.assign({
        organizationId,
        membershipId,
        roleId: body.roleId,
        roleKey: role.key,
        scope: body.scope,
        expiresAt,
        grantedByUserId: userId,
      });
      await auditRoleAssigned(deps.audit, auditContextFor(request), {
        membershipId,
        roleKey: role.key,
        scope: body.scope,
        expiresAt,
      });
      // §2.5 — the grantee's cached set is stale the instant the grant lands. Org-wide drop (the
      // resolver caches by (org,user) and the grantee's USER id is not in this handler's scope).
      deps.rbacInvalidation?.invalidateOrg(organizationId);
      return reply.code(201).send(grant);
    },
  );

  app.delete(
    "/api/v1/memberships/:id/roles/:rid",
    { preHandler: [requirePermission("role.assign") as PreHandler] },
    async (request, reply) => {
      const { organizationId } = actorOf(request.context);
      const { id: membershipId, rid: roleId } = parse(MembershipRoleParams, request.params);
      const role = await deps.roles.get(roleId);
      const revoked = await deps.membershipRoles.revoke(membershipId, roleId);
      if (!revoked) throw notFound("role grant");
      await auditRoleRevoked(deps.audit, auditContextFor(request), {
        membershipId,
        roleKey: role?.key ?? roleId,
      });
      // §2.5 — a revoked grant must stop authorizing NOW, not at cache expiry.
      deps.rbacInvalidation?.invalidateOrg(organizationId);
      return reply.code(200).send({ revoked: true });
    },
  );

  // --- self: effective permissions (drives UI gating, §4.3) -------------------------------
  app.get(
    "/api/v1/me/permissions",
    { preHandler: [requireSession() as PreHandler] },
    async (request) => {
      const { organizationId, userId } = actorOf(request.context);
      const permissions = await deps.effectivePermissions({ organizationId, userId });
      return { permissions: [...permissions] };
    },
  );

  // --- §7.4 break-glass emergency access --------------------------------------------------
  app.post(
    "/api/v1/breakglass",
    { preHandler: [requirePermission("breakglass.invoke") as PreHandler] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request.context);
      // §7.4 D1 — the ≥10-char reason floor is the schema's `minLength` (422 on a keystroke).
      const body = parse(InvokeBreakGlassBody, request.body);
      const reason = body.reason;
      // Non-null by schema now: an absent target used to mint scope-level glass that covered every
      // ABAC target in the org. See InvokeBreakGlassBody for why that was the same defect class as
      // the caller-supplied `cosignRequired` the audit C2 fix removed.
      const targetPatientId = body.targetPatientId;
      // audit C2 — TENANT POLICY decides whether this grant opens `cosign_pending`, never the
      // caller. Reading it from the body let one permission (`breakglass.invoke`) self-issue an
      // un-cosigned, scope-level grant that satisfies every ABAC predicate AND every step-up
      // ceremony in the org. `breakglass_cosign_required` defaults to false (see the registry
      // entry: `cosign_pending` grants no access, so a true default would withhold emergency
      // chart access). Any `cosignRequired` in the body is ignored — the schema no longer accepts it.
      const cosignRequired = await deps.cosignPolicy(organizationId);

      const event = await deps.breakGlass.invoke({
        organizationId,
        actorUserId: userId,
        targetPatientId,
        reason,
        cosignRequired,
        ttlSeconds: breakGlassTtlSec,
      });
      await auditBreakGlassInvoked(deps.audit, auditContextFor(request), {
        eventId: event.eventId,
        targetPatientId,
        reason,
        expiresAt: event.expiresAt,
        cosignRequired,
      });
      // Compliance is notified via the m3.breakglass.invoked OUTBOX path (M36 delivers; SD-017).
      await deps.notifier.notify({
        kind: "breakglass.invoked",
        organizationId,
        resourceId: event.eventId,
        severity: "critical",
      });
      return reply.code(201).send({
        breakGlassId: event.eventId,
        status: event.status,
        expiresAt: event.expiresAt,
      });
    },
  );

  app.post(
    "/api/v1/breakglass/:id/cosign",
    { preHandler: [requirePermission("breakglass.cosign") as PreHandler] },
    async (request, reply) => {
      const { userId } = actorOf(request.context);
      const { id: eventId } = parse(BreakGlassIdParams, request.params);
      if (!(await deps.breakGlass.get(eventId))) throw notFound("break-glass event");
      let event: BreakGlassView;
      try {
        event = await deps.breakGlass.cosign(eventId, userId);
      } catch (err) {
        // A refused co-signature is a signal worth keeping, not just an error to return: a
        // self-cosign attempt is someone trying to approve their own emergency PHI access, and
        // it is exactly what a Compliance reviewer wants to find in the trail. Audited BEFORE
        // the throw so the row survives the 409.
        if (err instanceof BreakGlassCosignError) {
          await auditBreakGlassCosignRefused(deps.audit, auditContextFor(request), {
            eventId,
            reason: err.kind,
          });
          throw cosignRefusedToHttp(err);
        }
        throw err;
      }
      await auditBreakGlassCosigned(deps.audit, auditContextFor(request), { eventId });
      return reply.code(200).send({ breakGlassId: event.eventId, status: event.status });
    },
  );

  app.post(
    "/api/v1/breakglass/:id/revoke",
    { preHandler: [requirePermission("breakglass.cosign") as PreHandler] },
    async (request, reply) => {
      actorOf(request.context);
      const { id: eventId } = parse(BreakGlassIdParams, request.params);
      if (!(await deps.breakGlass.get(eventId))) throw notFound("break-glass event");
      const event = await deps.breakGlass.revoke(eventId);
      await auditBreakGlassRevoked(deps.audit, auditContextFor(request), { eventId });
      return reply.code(200).send({ breakGlassId: event.eventId, status: event.status });
    },
  );

  app.get(
    "/api/v1/breakglass",
    { preHandler: [requirePermission("breakglass.read") as PreHandler] },
    async (request) => {
      const { organizationId } = actorOf(request.context);
      return { events: await deps.breakGlass.listForOrg(organizationId) };
    },
  );

  // --- §7.5 auditor engagement, least privilege + accountability --------------------------
  app.post(
    "/api/v1/engagements",
    { preHandler: [requirePermission("engagement.manage") as PreHandler] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request.context);
      const body = parse(CreateEngagementBody, request.body);
      const { engagementType, auditorAgency, startAt, endAt } = body;
      // The cross-field rule TypeBox cannot express — mirrors the `auditor_engagement_window_chk`
      // CHECK constraint (§3.7), refused here so it is a 422 and not a Postgres 23514.
      if (Date.parse(startAt) >= Date.parse(endAt)) {
        throw new ValidationError("invalid window", [
          { field: "endAt", code: "INVALID", message: "endAt must be after startAt" },
        ]);
      }
      const scope = body.scope ?? {};

      const engagement = await deps.engagements.create({
        organizationId,
        engagementType,
        auditorAgency,
        scope,
        startAt,
        endAt,
        createdByUserId: userId,
      });
      await auditEngagementCreated(deps.audit, auditContextFor(request), {
        engagementId: engagement.engagementId,
        engagementType,
        scope,
        startAt,
        endAt,
      });
      await deps.notifier.notify({
        kind: "engagement.created",
        organizationId,
        resourceId: engagement.engagementId,
        severity: "warn",
      });
      return reply.code(201).send(engagement);
    },
  );

  app.patch(
    "/api/v1/engagements/:id",
    { preHandler: [requirePermission("engagement.manage") as PreHandler] },
    async (request, reply) => {
      actorOf(request.context);
      const { id: engagementId } = parse(EngagementIdParams, request.params);
      if (!(await deps.engagements.get(engagementId))) throw notFound("engagement");
      const body = parse(UpdateEngagementBody, request.body);
      const cancel = body.cancel === true;
      const endAt = body.endAt;
      const changedFields = [cancel ? "status" : undefined, endAt ? "endAt" : undefined].filter(
        (f): f is string => f !== undefined,
      );

      const updated = await deps.engagements.update(engagementId, { cancel, endAt });
      await auditEngagementUpdated(deps.audit, auditContextFor(request), {
        engagementId,
        cancelled: cancel,
        changedFields,
      });
      return reply.code(200).send(updated);
    },
  );

  app.post(
    "/api/v1/engagements/:id/auditors",
    { preHandler: [requirePermission("engagement.manage") as PreHandler] },
    async (request, reply) => {
      const { organizationId } = actorOf(request.context);
      const { id: engagementId } = parse(EngagementIdParams, request.params);
      const engagement = await deps.engagements.get(engagementId);
      if (!engagement) throw notFound("engagement");
      const { name, email } = parse(EnrollAuditorBody, request.body);

      // M3 owns the engagement scope; M2 mints the time-boxed magic-link session (D4 / §4.4).
      await deps.auditorSessions.mintAuditorSession({
        engagementId,
        organizationId,
        identity: { name, email },
        window: { start: new Date(engagement.startAt), end: new Date(engagement.endAt) },
      });
      await deps.engagements.recordAuditorEnrolled(engagementId);
      await auditAuditorEnrolled(deps.audit, auditContextFor(request), {
        engagementId,
        auditorEmail: email,
      });
      // The magic-link token is delivered out-of-band (email) — never returned in the body.
      return reply.code(201).send({ engagementId, status: "pending" });
    },
  );

  app.get(
    "/api/v1/engagements/:id/summary",
    { preHandler: [requirePermission("engagement.read") as PreHandler] },
    async (request) => {
      actorOf(request.context);
      const { id: engagementId } = parse(EngagementIdParams, request.params);
      const summary = await deps.engagements.summary(engagementId);
      if (!summary) throw notFound("engagement");
      return summary;
    },
  );
}

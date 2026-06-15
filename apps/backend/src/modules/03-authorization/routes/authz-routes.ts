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
import type { AuditContext } from "@wardenx/audit";
import { permissionMirrorRows, requirePermission, requireSession } from "@wardenx/auth";
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
import { type AuthzRouteDeps, RoleLockedError, type ScopeLevelInput } from "../authz-ports";

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

/** Map a store-level RoleLockedError onto the spec's HTTP code (409). */
function roleLockedToHttp(err: RoleLockedError): WardenXError {
  return new WardenXError("ROLE_LOCKED", err.message, 409);
}

const notFound = (what: string) => new WardenXError("NOT_FOUND", `${what} not found`, 404);

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
    async () => ({ permissions: permissionMirrorRows() }),
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
      const body = (request.body ?? {}) as Record<string, unknown>;
      const key = readString(body, "key");
      const name = readString(body, "name");
      const category = readString(body, "category");
      const scopeLevel = (
        typeof body.scopeLevel === "string" ? body.scopeLevel : "location"
      ) as ScopeLevelInput;
      const permissionKeys = readStringArray(body, "permissionKeys");
      const clonedFromKey = typeof body.clonedFromKey === "string" ? body.clonedFromKey : undefined;

      await assertNoEscalation(request, organizationId, userId, permissionKeys);

      const role = await deps.roles.createCustom({
        organizationId,
        key,
        name,
        category,
        scopeLevel,
        clonedFromKey,
        permissionKeys,
      });
      await auditRoleCreated(deps.audit, auditContextFor(request), {
        roleId: role.roleId,
        roleKey: role.key,
        clonedFrom: clonedFromKey,
      });
      return reply.code(201).send(role);
    },
  );

  app.patch(
    "/api/v1/roles/:id",
    { preHandler: [requirePermission("role.manage") as PreHandler] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request.context);
      const roleId = (request.params as { id: string }).id;
      const existing = await deps.roles.get(roleId);
      if (!existing) throw notFound("role");

      const body = (request.body ?? {}) as Record<string, unknown>;
      const patch: { name?: string; enabled?: boolean; permissionKeys?: string[] } = {};
      const changedFields: string[] = [];
      if (typeof body.name === "string") {
        patch.name = body.name;
        changedFields.push("name");
      }
      if (typeof body.enabled === "boolean") {
        patch.enabled = body.enabled;
        changedFields.push("enabled");
      }
      if (body.permissionKeys !== undefined) {
        patch.permissionKeys = readStringArray(body, "permissionKeys");
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
      return reply.code(200).send(updated);
    },
  );

  app.delete(
    "/api/v1/roles/:id",
    { preHandler: [requirePermission("role.manage") as PreHandler] },
    async (request, reply) => {
      actorOf(request.context);
      const roleId = (request.params as { id: string }).id;
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
      return reply.code(200).send({ deleted: true });
    },
  );

  // --- §6 role assignment -----------------------------------------------------------------
  app.get(
    "/api/v1/memberships/:id/roles",
    { preHandler: [requirePermission("role.read") as PreHandler] },
    async (request) => {
      actorOf(request.context);
      const membershipId = (request.params as { id: string }).id;
      return { roles: await deps.membershipRoles.listForMembership(membershipId) };
    },
  );

  app.post(
    "/api/v1/memberships/:id/roles",
    { preHandler: [requirePermission("role.assign") as PreHandler] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request.context);
      const membershipId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const roleId = readString(body, "roleId");

      const role = await deps.roles.get(roleId);
      if (!role) throw notFound("role");
      // Anti-escalation: an admin may not confer permissions they do not themselves hold.
      await assertNoEscalation(request, organizationId, userId, role.permissionKeys);

      const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : null;
      const grant = await deps.membershipRoles.assign({
        organizationId,
        membershipId,
        roleId,
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
      return reply.code(201).send(grant);
    },
  );

  app.delete(
    "/api/v1/memberships/:id/roles/:rid",
    { preHandler: [requirePermission("role.assign") as PreHandler] },
    async (request, reply) => {
      actorOf(request.context);
      const { id: membershipId, rid: roleId } = request.params as { id: string; rid: string };
      const role = await deps.roles.get(roleId);
      const revoked = await deps.membershipRoles.revoke(membershipId, roleId);
      if (!revoked) throw notFound("role grant");
      await auditRoleRevoked(deps.audit, auditContextFor(request), {
        membershipId,
        roleKey: role?.key ?? roleId,
      });
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
      const body = (request.body ?? {}) as Record<string, unknown>;
      const reason = typeof body.reason === "string" ? body.reason : "";
      if (reason.length < 10) {
        throw new ValidationError("reason too short", [
          { field: "reason", code: "TOO_SHORT", message: "a reason of ≥10 chars is required" },
        ]);
      }
      const targetPatientId =
        typeof body.targetPatientId === "string" ? body.targetPatientId : null;
      // Tenant policy may require a non-emergency co-sign (→ status cosign_pending).
      const cosignRequired = body.cosignRequired === true;

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
      const eventId = (request.params as { id: string }).id;
      if (!(await deps.breakGlass.get(eventId))) throw notFound("break-glass event");
      const event = await deps.breakGlass.cosign(eventId, userId);
      await auditBreakGlassCosigned(deps.audit, auditContextFor(request), { eventId });
      return reply.code(200).send({ breakGlassId: event.eventId, status: event.status });
    },
  );

  app.post(
    "/api/v1/breakglass/:id/revoke",
    { preHandler: [requirePermission("breakglass.cosign") as PreHandler] },
    async (request, reply) => {
      actorOf(request.context);
      const eventId = (request.params as { id: string }).id;
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
      const body = (request.body ?? {}) as Record<string, unknown>;
      const engagementType = readString(body, "engagementType");
      const auditorAgency = readString(body, "auditorAgency");
      const startAt = readString(body, "startAt");
      const endAt = readString(body, "endAt");
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
      const engagementId = (request.params as { id: string }).id;
      if (!(await deps.engagements.get(engagementId))) throw notFound("engagement");
      const body = (request.body ?? {}) as Record<string, unknown>;
      const cancel = body.cancel === true;
      const endAt = typeof body.endAt === "string" ? body.endAt : undefined;
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
      const engagementId = (request.params as { id: string }).id;
      const engagement = await deps.engagements.get(engagementId);
      if (!engagement) throw notFound("engagement");
      const body = (request.body ?? {}) as Record<string, unknown>;
      const name = readString(body, "name");
      const email = readString(body, "email");

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
      const engagementId = (request.params as { id: string }).id;
      const summary = await deps.engagements.summary(engagementId);
      if (!summary) throw notFound("engagement");
      return summary;
    },
  );
}

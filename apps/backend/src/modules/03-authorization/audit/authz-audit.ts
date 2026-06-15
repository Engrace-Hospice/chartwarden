// apps/backend/src/modules/03-authorization/audit/authz-audit.ts — M3-T08 authorization
// route-inventory audit events (M3 spec §8.1; §7.4–7.6 "all … audited").
//
// Every role change, break-glass invocation, and engagement action the §4.3 route inventory
// performs goes through the mandated @wardenx/audit `audit()` surface — never a direct
// `audit_event` insert — so each snapshot runs through the PHI field denylist and is filed
// under a retention class. Per §8.1 (ADR-0004): ALL authorization events are `compliance`
// retention; break-glass invocation and each per-resource access under glass are `critical`,
// role/engagement lifecycle changes are `warn`. The `tx` (AuditExecutor) is injected:
// production passes the Drizzle transaction so the audit row commits atomically with the
// state change; the slice passes an in-memory executor.
//
// M3-T10 completes the §8.1 catalog: the route-inventory lifecycle rows (T08, below) plus the
// `m3.authz.denied` sampled-denial event (D5) — closing the M3 audit-event catalog.
import { type AuditContext, type AuditExecutor, audit } from "@wardenx/audit";

/** The M3 authorization audit event types (dotted `m3.<resource>.<verb>`, §8.1). */
export const AUTHZ_AUDIT_EVENTS = {
  authzDenied: "m3.authz.denied",
  roleCreated: "m3.role.created",
  roleUpdated: "m3.role.updated",
  roleDeleted: "m3.role.deleted",
  roleAssigned: "m3.role.assigned",
  roleRevoked: "m3.role.revoked",
  escalationBlocked: "m3.authz.escalation_blocked",
  breakGlassInvoked: "m3.breakglass.invoked",
  breakGlassAccess: "m3.breakglass.access",
  breakGlassCosigned: "m3.breakglass.cosigned",
  breakGlassRevoked: "m3.breakglass.revoked",
  engagementCreated: "m3.engagement.created",
  engagementUpdated: "m3.engagement.updated",
  engagementCancelled: "m3.engagement.cancelled",
  auditorEnrolled: "m3.engagement.auditor_enrolled",
} as const;

/** Record a custom role being created (cloned/extended from a template; §7.6). */
export async function auditRoleCreated(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { roleId: string; roleKey: string; clonedFrom?: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.roleCreated,
    resourceKind: "role",
    resourceId: input.roleId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    after: { roleKey: input.roleKey, clonedFrom: input.clonedFrom },
  });
}

/** Record a role being edited (rename / enable-disable / permission-set edit; §7.6). */
export async function auditRoleUpdated(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { roleId: string; roleKey: string; changedFields: readonly string[] },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.roleUpdated,
    resourceKind: "role",
    resourceId: input.roleId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    after: { roleKey: input.roleKey, changedFields: [...input.changedFields] },
  });
}

/** Record a custom role being deleted. */
export async function auditRoleDeleted(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { roleId: string; roleKey: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.roleDeleted,
    resourceKind: "role",
    resourceId: input.roleId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    before: { roleKey: input.roleKey },
  });
}

/** Record a role being granted on a membership (warn + notifies the user; §6). */
export async function auditRoleAssigned(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: {
    membershipId: string;
    roleKey: string;
    scope?: unknown;
    expiresAt?: string | null;
  },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.roleAssigned,
    resourceKind: "membership_role",
    resourceId: input.membershipId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    after: { roleKey: input.roleKey, scope: input.scope, expiresAt: input.expiresAt ?? null },
  });
}

/** Record a role being revoked from a membership. */
export async function auditRoleRevoked(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { membershipId: string; roleKey: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.roleRevoked,
    resourceKind: "membership_role",
    resourceId: input.membershipId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    before: { roleKey: input.roleKey },
  });
}

/** Record an anti-escalation block — an admin tried to grant a permission they lack (§6). */
export async function auditEscalationBlocked(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { attemptedPermission: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.escalationBlocked,
    resourceKind: "role",
    outcome: "denied",
    severity: "warn",
    retentionClass: "compliance",
    context: { attemptedPermission: input.attemptedPermission },
  });
}

/**
 * Record a routine authorization denial (§8.1 `m3.authz.denied`). Unlike the role/break-glass
 * rows this is `operational` retention and **sampled** (D5): the full forensic value of a
 * denial lives in the break-glass + role-change rows and the escalation block, so routine 403s
 * are logged at `operational` (1-year) volume, not the `compliance` floor. The payload names
 * the gate that fired (RBAC permission or ABAC predicate) and the target type — never PHI
 * contents (§8.3). Call from the gate's denial path under the tenant's denial-sampling policy.
 */
export async function auditAuthzDenied(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: {
    permission?: string;
    predicate?: string;
    targetType?: string;
    reason: string;
  },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.authzDenied,
    resourceKind: input.targetType ?? "authz",
    outcome: "denied",
    severity: "info",
    retentionClass: "operational",
    context: {
      permission: input.permission ?? null,
      predicate: input.predicate ?? null,
      reason: input.reason,
    },
  });
}

/** Record a break-glass invocation (critical; Compliance notified out-of-band; §7.4). */
export async function auditBreakGlassInvoked(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: {
    eventId: string;
    targetPatientId: string | null;
    reason: string;
    expiresAt: string;
    cosignRequired: boolean;
  },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.breakGlassInvoked,
    resourceKind: "break_glass_event",
    resourceId: input.eventId,
    outcome: "success",
    severity: "critical",
    retentionClass: "compliance",
    after: {
      targetPatientId: input.targetPatientId,
      reason: input.reason,
      expiresAt: input.expiresAt,
      cosignRequired: input.cosignRequired,
    },
  });
}

/** Record ONE resource being viewed under glass (critical, per access; §2.2 / §7.4). */
export async function auditBreakGlassAccess(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { eventId: string; resourceType: string; resourceId?: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.breakGlassAccess,
    resourceKind: input.resourceType,
    resourceId: input.resourceId,
    outcome: "success",
    severity: "critical",
    retentionClass: "compliance",
    context: { breakGlassEventId: input.eventId },
  });
}

/** Record a break-glass event being co-signed by Compliance. */
export async function auditBreakGlassCosigned(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { eventId: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.breakGlassCosigned,
    resourceKind: "break_glass_event",
    resourceId: input.eventId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
  });
}

/** Record a break-glass event being ended early (revoked) before its time-box. */
export async function auditBreakGlassRevoked(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { eventId: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.breakGlassRevoked,
    resourceKind: "break_glass_event",
    resourceId: input.eventId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
  });
}

/** Record an auditor engagement being created (time-bound, least-privilege; §7.5). */
export async function auditEngagementCreated(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: {
    engagementId: string;
    engagementType: string;
    scope: unknown;
    startAt: string;
    endAt: string;
  },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.engagementCreated,
    resourceKind: "auditor_engagement",
    resourceId: input.engagementId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    after: {
      engagementType: input.engagementType,
      scope: input.scope,
      startAt: input.startAt,
      endAt: input.endAt,
    },
  });
}

/** Record an engagement being edited or cancelled. */
export async function auditEngagementUpdated(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { engagementId: string; cancelled: boolean; changedFields: readonly string[] },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: input.cancelled
      ? AUTHZ_AUDIT_EVENTS.engagementCancelled
      : AUTHZ_AUDIT_EVENTS.engagementUpdated,
    resourceKind: "auditor_engagement",
    resourceId: input.engagementId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    after: { changedFields: [...input.changedFields] },
  });
}

/** Record an auditor being enrolled into an engagement (M2 mints the magic-link; §7.5). */
export async function auditAuditorEnrolled(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { engagementId: string; auditorEmail: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUTHZ_AUDIT_EVENTS.auditorEnrolled,
    resourceKind: "auditor_engagement",
    resourceId: input.engagementId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    // `email` is a denylisted leaf key → redacted by audit() before the row is written.
    after: { email: input.auditorEmail },
  });
}

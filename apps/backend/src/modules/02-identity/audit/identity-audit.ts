// apps/backend/src/modules/02-identity/audit/identity-audit.ts — M2-T06 identity
// lifecycle audit events (M2 spec §8.1; §7.1, §7.5, §7.6 "all … audited").
//
// Every membership/invitation/collaborator/user state change the §7.1–7.7 workflows demand
// be "audited" goes through the mandated @wardenx/audit `audit()` surface — never a direct
// `audit_event` insert — so each snapshot is run through the PHI field denylist (the
// invitee's `email` is redacted in the trail) and filed under a retention class. Per M02-F12
// the spec's `security` retention class is remapped to `compliance` (HIPAA floor). The `tx`
// (AuditExecutor) is injected: production passes the Drizzle transaction so the audit row
// commits atomically with the membership/invitation write (§7.3); the slice passes an
// in-memory executor (see step-up-ports.ts `createInMemoryAuditExecutor`).
//
// Full M2 audit-event catalog + the M3 permission-key registration land in M2-T08; these are
// the lifecycle rows the route-inventory workflows directly emit.
import { type AuditContext, type AuditExecutor, audit } from "@wardenx/audit";

/** The M2 identity lifecycle audit event types (dotted `m2.<resource>.<verb>`). */
export const IDENTITY_AUDIT_EVENTS = {
  userInvited: "m2.user.invited",
  invitationRescinded: "m2.invitation.rescinded",
  membershipAccepted: "m2.membership.accepted",
  membershipSuspended: "m2.membership.suspended",
  membershipReinstated: "m2.membership.reinstated",
  membershipUpdated: "m2.membership.updated",
  membershipRevoked: "m2.membership.revoked",
  userDeactivated: "m2.user.deactivated",
  collaboratorInvited: "m2.collaborator.invited",
  collaboratorSessionStarted: "m2.collaborator.session_started",
} as const;

/** Record an org invitation being minted (token never enters the payload; email redacted). */
export async function auditUserInvited(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { invitationId: string; organizationId: string; email: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: IDENTITY_AUDIT_EVENTS.userInvited,
    resourceKind: "invitation",
    resourceId: input.invitationId,
    outcome: "success",
    retentionClass: "compliance",
    after: { organizationId: input.organizationId, email: input.email },
  });
}

/** Record a pending invitation being rescinded by an admin. */
export async function auditInvitationRescinded(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { invitationId: string; organizationId: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: IDENTITY_AUDIT_EVENTS.invitationRescinded,
    resourceKind: "invitation",
    resourceId: input.invitationId,
    outcome: "success",
    retentionClass: "compliance",
    context: { organizationId: input.organizationId },
  });
}

/** Record an invitee accepting an invite → active membership (spec §7.1). */
export async function auditMembershipAccepted(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { membershipId: string; organizationId: string; userId: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: IDENTITY_AUDIT_EVENTS.membershipAccepted,
    resourceKind: "membership",
    resourceId: input.membershipId,
    outcome: "success",
    retentionClass: "compliance",
    after: { organizationId: input.organizationId, userId: input.userId },
  });
}

/**
 * Record the §D3 role attach that runs on accept (F-097).
 *
 * `m3.role.assigned` rather than a new `m2.*` action: the grant is M3's row and M3's compliance
 * record, and the admin surface that answers "who gave this person this role, and when" reads that
 * action. Emitting a second, M2-flavoured name for the same fact would split that answer in two.
 *
 * `unresolved` is on the record on purpose. A key the org has no role for means the invitation asked
 * for access the tenant cannot express, and the audit trail is the only place that fact survives — the
 * invitee sees a working login and the inviting admin sees an invitation marked accepted.
 */
export async function auditRolesAttachedOnAccept(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: {
    membershipId: string;
    organizationId: string;
    attached: readonly string[];
    unresolved: readonly string[];
  },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: "m3.role.assigned",
    resourceKind: "membership",
    resourceId: input.membershipId,
    // `audit_outcome` is (success | failure | denied) — there is no `partial`. A grant set that came
    // back EMPTY while the invitation asked for roles is a failure of this step, whatever the accept
    // did; anything attached is a success carrying the unresolved names as detail.
    outcome: input.attached.length === 0 ? "failure" : "success",
    retentionClass: "compliance",
    after: {
      organizationId: input.organizationId,
      attachedRoleKeys: [...input.attached],
      unresolvedRoleKeys: [...input.unresolved],
      source: "invitation_accept",
    },
  });
}

/** Record a membership status change (suspend / reinstate / generic update; spec §7.5). */
export async function auditMembershipStatusChanged(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: {
    membershipId: string;
    organizationId: string;
    from: string;
    to: string;
    reason?: string;
  },
): Promise<void> {
  const eventType =
    input.to === "suspended"
      ? IDENTITY_AUDIT_EVENTS.membershipSuspended
      : input.from === "suspended" && input.to === "active"
        ? IDENTITY_AUDIT_EVENTS.membershipReinstated
        : IDENTITY_AUDIT_EVENTS.membershipUpdated;
  await audit(tx, ctx, {
    eventType,
    resourceKind: "membership",
    resourceId: input.membershipId,
    outcome: "success",
    retentionClass: "compliance",
    before: { status: input.from },
    after: { status: input.to },
    context: { organizationId: input.organizationId, reason: input.reason },
  });
}

/** Record a membership being revoked → that org's sessions terminated (spec §7.5). */
export async function auditMembershipRevoked(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { membershipId: string; organizationId: string; reason?: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: IDENTITY_AUDIT_EVENTS.membershipRevoked,
    resourceKind: "membership",
    resourceId: input.membershipId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    context: { organizationId: input.organizationId, reason: input.reason },
  });
}

/** Record a full user deactivation — credentials disabled everywhere (spec §7.5). */
export async function auditUserDeactivated(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { userId: string; reason: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: IDENTITY_AUDIT_EVENTS.userDeactivated,
    resourceKind: "user",
    resourceId: input.userId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    context: { reason: input.reason },
  });
}

/** Record a per-patient external-collaborator magic-link being minted (spec §7.6). */
export async function auditCollaboratorInvited(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { linkId: string; organizationId: string; patientId: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: IDENTITY_AUDIT_EVENTS.collaboratorInvited,
    resourceKind: "collaborator_link",
    resourceId: input.linkId,
    outcome: "success",
    retentionClass: "compliance",
    context: { organizationId: input.organizationId, patientId: input.patientId },
  });
}

/** Record an external-collaborator session being issued from a consumed link (spec §7.6). */
export async function auditCollaboratorSessionStarted(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { sessionId: string; organizationId: string; patientId: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: IDENTITY_AUDIT_EVENTS.collaboratorSessionStarted,
    resourceKind: "session",
    resourceId: input.sessionId,
    outcome: "success",
    retentionClass: "compliance",
    context: { organizationId: input.organizationId, patientId: input.patientId },
  });
}

// apps/backend/src/modules/02-identity/audit/session-link-audit.ts — audit events for the two ways an
// unauthenticated-or-pre-org caller becomes a SCOPED session: redeeming a collaborator / funeral-home link, and a
// portal invitee binding their signed-in session to a portal account.
//
// Every row goes through the mandated @wardenx/audit `audit()` helper at `compliance` retention. IDS ONLY: the link
// token, its hash, the invitee's address and any patient detail never enter a payload (the field denylist runs in
// `audit()` as a second line, but the first line is that nothing sensitive is passed).
import { type AuditContext, type AuditExecutor, audit } from "@wardenx/audit";

export const SESSION_LINK_AUDIT_EVENTS = {
  linkRedeemed: "m2.link.redeemed",
  linkRedemptionRefused: "m2.link.redemption_refused",
  portalSessionEstablished: "m2.portal.session_established",
  portalSessionRefused: "m2.portal.session_refused",
} as const;

export type LinkKind = "external_collaborator" | "funeral_home";

/** A link was redeemed into a scoped session. */
export async function auditLinkRedeemed(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { linkId: string; sessionId: string; kind: LinkKind; patientId: string; useCount: number },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: SESSION_LINK_AUDIT_EVENTS.linkRedeemed,
    resourceKind: "collaborator_link",
    resourceId: input.linkId,
    outcome: "success",
    retentionClass: "compliance",
    context: {
      sessionId: input.sessionId,
      kind: input.kind,
      patientId: input.patientId,
      useCount: input.useCount,
    },
  });
}

/** A redemption of a link the server knows was refused. `reason` is a closed token, never free text. */
export async function auditLinkRedemptionRefused(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { linkId: string; kind: LinkKind; reason: "expired" | "used" | "revoked" | "not_eligible" },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: SESSION_LINK_AUDIT_EVENTS.linkRedemptionRefused,
    resourceKind: "collaborator_link",
    resourceId: input.linkId,
    outcome: "denied",
    severity: "warn",
    retentionClass: "compliance",
    context: { kind: input.kind, reason: input.reason },
  });
}

/** A pre-org session was bound to a portal account. */
export async function auditPortalSessionEstablished(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { sessionId: string; portalAccountId: string; sessionClass: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: SESSION_LINK_AUDIT_EVENTS.portalSessionEstablished,
    resourceKind: "portal_account",
    resourceId: input.portalAccountId,
    outcome: "success",
    retentionClass: "compliance",
    context: { sessionId: input.sessionId, sessionClass: input.sessionClass },
  });
}

/** A portal sign-in bind was refused for a known portal account. */
export async function auditPortalSessionRefused(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { sessionId: string; portalAccountId: string; reason: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: SESSION_LINK_AUDIT_EVENTS.portalSessionRefused,
    resourceKind: "portal_account",
    resourceId: input.portalAccountId,
    outcome: "denied",
    severity: "warn",
    retentionClass: "compliance",
    context: { sessionId: input.sessionId, reason: input.reason },
  });
}

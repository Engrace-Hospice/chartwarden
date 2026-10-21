// apps/backend/src/modules/02-identity/portal-sign-in-store.ts — M2's half of the M31 portal invitee SIGN-IN.
//
// M2 owns authentication and the `session` row; M31 owns the portal ACCOUNT. After an invitee authenticates
// (Better Auth: magic link / password + TOTP / passkey) the session is PRE-ORG. M31's sign-in routes decide whether
// it may become a portal session (`31-portal/sign-in`); this file does the two things only M2 may do:
//
//   accountsForUser — the cross-tenant read of the signed-in user's OWN portal accounts, through the narrow
//                     SECURITY DEFINER function `m31_list_own_portal_accounts` (migration 0520). The user id is the
//                     authenticated session's; the function cannot enumerate anyone else, and returns no contact PHI.
//   bindSession     — ONE conditional UPDATE on the `session` row that sets the organization, the portal session
//                     class and `scope.portalAccountId` TOGETHER (so `session_scope_chk` holds at every instant). It
//                     matches on session id AND user id AND "still pre-org staff-class", so a session that is
//                     already bound to anything cannot be re-scoped by this path: the caller sees `refused`, or
//                     `already_bound` for an idempotent replay of the identical bind. Rows are matched on id and the
//                     result is asserted from RETURNING, never assumed.
//
// The port is declared structurally here (M31 declares the same shape): M2 takes no import edge on M31, and the
// composition root wires the two (the `PortalInviteeUserPort` precedent).
import type { AuditExecutor } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  auditPortalSessionEstablished,
  auditPortalSessionRefused,
} from "./audit/session-link-audit";

type PortalAccountRelationship = (typeof schema.portalAccountRelationship.enumValues)[number];
type PortalAccountStatus = (typeof schema.portalAccountStatus.enumValues)[number];
type PortalSessionClass = "patient_portal" | "caregiver_portal" | "bereaved_portal";

export interface PortalSignInAccountRow {
  readonly portalAccountId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationStatus: string;
  readonly relationship: PortalAccountRelationship;
  readonly accountStatus: PortalAccountStatus;
  readonly userEmailVerified: boolean;
  readonly userStatus: string;
  readonly liveGrantCount: number;
  readonly bereavedGrantCount: number;
}

export interface PortalSignInStore {
  accountsForUser(userId: string): Promise<readonly PortalSignInAccountRow[]>;
  bindSession(input: {
    sessionId: string;
    userId: string;
    organizationId: string;
    portalAccountId: string;
    sessionClass: PortalSessionClass;
    ip: string;
    userAgent: string | null;
  }): Promise<"bound" | "already_bound" | "refused">;
  recordRefusal(input: {
    sessionId: string;
    userId: string;
    organizationId: string;
    portalAccountId: string;
    reason: string;
    ip: string;
    userAgent: string | null;
  }): Promise<void>;
}

interface AccountDbRow {
  portal_account_id: string;
  organization_id: string;
  organization_name: string;
  organization_status: string;
  relationship: PortalAccountRelationship;
  account_status: PortalAccountStatus;
  user_email_verified: boolean;
  user_status: string;
  live_grant_count: number;
  bereaved_grant_count: number;
}

const SESSIONS = schema.sessions;

export function createPortalSignInStore(db: DbClient, audit: AuditExecutor): PortalSignInStore {
  const auditContext = (
    organizationId: string,
    userId: string,
    sessionId: string,
    ip: string,
    userAgent: string | null,
  ) => ({
    organizationId,
    userId,
    actorKind: "user" as const,
    correlationId: sessionId,
    sourceIp: ip,
    ...(userAgent ? { userAgent } : {}),
  });

  return {
    async accountsForUser(userId) {
      const result = await db.execute(sql`SELECT * FROM m31_list_own_portal_accounts(${userId})`);
      const rows = (result as unknown as { rows?: AccountDbRow[] }).rows ?? [];
      return rows.map((r) => ({
        portalAccountId: r.portal_account_id,
        organizationId: r.organization_id,
        organizationName: r.organization_name,
        organizationStatus: r.organization_status,
        relationship: r.relationship,
        accountStatus: r.account_status,
        userEmailVerified: r.user_email_verified,
        userStatus: r.user_status,
        liveGrantCount: Number(r.live_grant_count),
        bereavedGrantCount: Number(r.bereaved_grant_count),
      }));
    },

    async bindSession(input) {
      const bound = await db
        .update(SESSIONS)
        .set({
          activeOrganizationId: input.organizationId,
          sessionClass: input.sessionClass,
          scope: sql`COALESCE(${SESSIONS.scope}, '{}'::jsonb) || ${JSON.stringify({ portalAccountId: input.portalAccountId })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(SESSIONS.id, input.sessionId),
            eq(SESSIONS.userId, input.userId),
            isNull(SESSIONS.activeOrganizationId),
            eq(SESSIONS.sessionClass, "staff"),
          ),
        )
        .returning({ id: SESSIONS.id });
      if (bound.length === 1) {
        await auditPortalSessionEstablished(
          audit,
          auditContext(
            input.organizationId,
            input.userId,
            input.sessionId,
            input.ip,
            input.userAgent,
          ),
          {
            sessionId: input.sessionId,
            portalAccountId: input.portalAccountId,
            sessionClass: input.sessionClass,
          },
        );
        return "bound";
      }
      // Not pre-org any more. The ONLY acceptable reason is an idempotent replay of the identical bind.
      const same = await db
        .select({ id: SESSIONS.id })
        .from(SESSIONS)
        .where(
          and(
            eq(SESSIONS.id, input.sessionId),
            eq(SESSIONS.userId, input.userId),
            eq(SESSIONS.activeOrganizationId, input.organizationId),
            eq(SESSIONS.sessionClass, input.sessionClass),
            sql`${SESSIONS.scope} ->> 'portalAccountId' = ${input.portalAccountId}`,
          ),
        )
        .limit(1);
      return same.length === 1 ? "already_bound" : "refused";
    },

    async recordRefusal(input) {
      await auditPortalSessionRefused(
        audit,
        auditContext(
          input.organizationId,
          input.userId,
          input.sessionId,
          input.ip,
          input.userAgent,
        ),
        {
          sessionId: input.sessionId,
          portalAccountId: input.portalAccountId,
          reason: input.reason,
        },
      );
    },
  };
}

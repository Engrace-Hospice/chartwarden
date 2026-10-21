// apps/backend/src/modules/02-identity/auditor-redemption.ts — redeem an auditor magic link into a
// scoped, read-only `auditor`-class session (M2 §2.2.4, §7.7; the batch-11 GAP-011 deferral: links were
// issued and consumable in SQL but nothing turned a consumed link into a session).
//
// WHAT REDEMPTION DOES, in one tenant-scoped transaction (RLS: `app.org_id`):
//   1. locks the link row (`FOR UPDATE`), re-checks the token with a constant-time digest comparison and
//      classifies it (live / consumed / revoked / expired / not-yet-open) — a replay or an expired link is
//      REFUSED, never re-issued;
//   2. asks M3's access port whether the engagement is still live and the identity may hold the auditor
//      role (an existing staff member is refused: an auditor session must not inherit staff permissions);
//   3. consumes the link (single-use: matched on id AND the live predicate, RETURNING asserted);
//   4. verifies the emailed mailbox (the link was delivered to that address only) and ensures an `active`
//      membership (it holds NO role yet);
//   5. enforces "no concurrent auditor sessions" (the user's other auditor sessions are deleted) and mints
//      an ENROLMENT-stage session through Better Auth (cookie signed as Better Auth signs it);
//   6. audits the redemption (M4) in the same transaction.
// The enrolment-stage session can reach ONLY the enrolment routes (auditor-enrolment.ts): the auditor must
// accept the versioned BAA / engagement terms and prove a second factor (enrol TOTP the first time, present a
// code or a recovery code afterwards). Only then is the least-privilege `external_auditor` role granted and the
// session upgraded to the read-only `active` stage - so possession of the emailed link alone reads nothing.
// A REFUSAL is audited and COMMITTED, then thrown by the caller: throwing inside the transaction would roll
// the refusal's audit row back with everything else.
//
import { type AuditContext, audit } from "@chartwarden/audit";
import { isUserStatusBlocked } from "@chartwarden/auth";
import type { AuditorSessionIssuer, IssuedAuditorSession } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { and, eq, ne } from "drizzle-orm";
import {
  type AuditorLinkRow,
  classifyAuditorLink,
  consumeAuditorLinkRow,
  findAuditorLinkByToken,
} from "./auditor-magic-link-store";
import { createPortalInviteeUserPort } from "./portal-invitee-user";

export type AuditorRefusalReason =
  | "unknown_link"
  | "consumed"
  | "revoked"
  | "expired"
  | "not_yet_open"
  | "engagement_not_active"
  | "identity_is_member"
  | "membership_not_active"
  | "role_over_privileged"
  | "user_inactive";

/** M3's side of the handshake (structural, so M2 takes no import edge on M3 — wired at the composition root). */
export interface AuditorAccessPort {
  /** Read-only pre-check inside the redemption transaction; `null` ⇒ the grant may proceed. */
  check(
    tx: DbClient,
    input: {
      organizationId: string;
      engagementId: string;
      membershipId: string | null;
      at: Date;
    },
  ): Promise<AuditorRefusalReason | null>;
  /** Attach the least-privilege auditor role to the membership until `expiresAt`. */
  grant(
    tx: DbClient,
    input: {
      organizationId: string;
      engagementId: string;
      membershipId: string;
      userId: string;
      expiresAt: Date;
    },
  ): Promise<void>;
}

export interface AuditorRedemptionDeps {
  readonly db: DbClient;
  readonly sessions: AuditorSessionIssuer;
  readonly access: AuditorAccessPort;
  /** Called once the redemption has COMMITTED (e.g. drop the actor's cached RBAC permission set). */
  readonly onRedeemed?: (organizationId: string, userId: string) => void;
  readonly now?: () => Date;
}

export interface AuditorRedemptionRequest {
  readonly organizationId: string;
  readonly token: string;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly correlationId: string;
  readonly requestId?: string;
}

export interface AuditorRedemption {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly engagementId: string;
  readonly expiresAt: Date;
  readonly setCookie: string;
}

/** The refusal → typed envelope map. Unknown and revoked links read the same: no oracle for which exist. */
export function auditorRefusalError(reason: AuditorRefusalReason): ChartWardenError {
  switch (reason) {
    case "consumed":
      return new ChartWardenError("LINK_ALREADY_USED", "this auditor link has already been used", 409);
    case "expired":
      return new ChartWardenError("LINK_EXPIRED", "this auditor link has expired", 410);
    case "not_yet_open":
      return new ChartWardenError(
        "ENGAGEMENT_NOT_OPEN",
        "this engagement's access window has not opened yet",
        403,
      );
    case "engagement_not_active":
      return new ChartWardenError("ENGAGEMENT_NOT_ACTIVE", "this engagement is not active", 403);
    case "identity_is_member":
      return new ChartWardenError(
        "AUDITOR_IDENTITY_IS_MEMBER",
        "this email belongs to a member of the organization; an auditor session cannot be minted for it",
        409,
      );
    case "membership_not_active":
      return new ChartWardenError(
        "MEMBERSHIP_NOT_ACTIVE",
        "this identity's membership in the organization is not active",
        403,
      );
    case "role_over_privileged":
      return new ChartWardenError(
        "AUDITOR_ROLE_MISCONFIGURED",
        "the organization's external auditor role holds more than the auditor minimum; an administrator must correct it",
        403,
      );
    case "user_inactive":
      return new ChartWardenError("USER_INACTIVE", "this account is not active", 403);
    default:
      return new ChartWardenError("LINK_INVALID", "this auditor link is not valid", 410);
  }
}

type RedeemOutcome = { readonly ok: true; readonly value: AuditorRedemption } | RefusedOutcome;
interface RefusedOutcome {
  readonly ok: false;
  readonly reason: AuditorRefusalReason;
}

function auditCtx(req: AuditorRedemptionRequest, userId: string | null): AuditContext {
  return {
    organizationId: req.organizationId,
    userId,
    actorKind: "user",
    correlationId: req.correlationId,
    ...(req.requestId ? { requestId: req.requestId } : {}),
    ...(req.ip ? { sourceIp: req.ip } : {}),
    ...(req.userAgent ? { userAgent: req.userAgent } : {}),
  };
}

async function auditRefusal(
  tx: DbClient,
  req: AuditorRedemptionRequest,
  link: Pick<AuditorLinkRow, "id" | "engagementId">,
  reason: AuditorRefusalReason,
): Promise<void> {
  await audit(tx, auditCtx(req, null), {
    eventType: "m2.auditor_link.refused",
    resourceKind: "auditor_magic_link",
    resourceId: link.id,
    outcome: "denied",
    severity: "warn",
    retentionClass: "compliance",
    context: { organizationId: req.organizationId, engagementId: link.engagementId, reason },
  });
}

/**
 * Redeem `token` for `organizationId`. Resolves to the minted session or throws the typed envelope error.
 * Unknown tokens are NOT audited (an anonymous caller must not be able to flood the audit log); every
 * refusal of a REAL link is.
 */
export async function redeemAuditorLink(
  deps: AuditorRedemptionDeps,
  req: AuditorRedemptionRequest,
): Promise<AuditorRedemption> {
  const now = (deps.now ?? (() => new Date()))();
  const { db } = deps;

  // 1. Peek (no lock): enough to learn the mailbox and to refuse a dead link before any write.
  const peeked = await withOrgContext(
    db,
    { organizationId: req.organizationId, userId: "" },
    (tx) =>
      findAuditorLinkByToken(tx as unknown as DbClient, req.organizationId, req.token, {
        lock: false,
      }),
  );
  if (!peeked) throw auditorRefusalError("unknown_link");
  const peekedState = classifyAuditorLink(peeked, now);
  if (peekedState !== "live") {
    await recordRefusal(db, req, peeked, peekedState);
    throw auditorRefusalError(peekedState);
  }

  // 2. The identity: find-or-create the `user` the link was issued to (committed — the session row FKs it).
  const invitee = createPortalInviteeUserPort(db);
  const { userId } = await invitee.ensureUser(req.organizationId, {
    email: peeked.auditorEmail,
    displayName: peeked.auditorName,
  });
  const userRows = await db
    .select({ status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (userRows[0] && isUserStatusBlocked(userRows[0].status)) {
    await recordRefusal(db, req, peeked, "user_inactive");
    throw auditorRefusalError("user_inactive");
  }

  // 3. The redemption transaction. The session row is written on a separate connection, so if the
  // transaction fails AFTER it was minted the session is deleted again (it would hold no permissions —
  // the role grant rolled back — but a dangling credential is not left behind either).
  let mintedSessionId: string | null = null;
  let outcome: RedeemOutcome;
  try {
    outcome = await redeemInTransaction();
  } catch (error) {
    if (mintedSessionId) {
      await db.delete(schema.sessions).where(eq(schema.sessions.id, mintedSessionId));
    }
    throw error;
  }
  if (!outcome.ok) throw auditorRefusalError(outcome.reason);
  deps.onRedeemed?.(outcome.value.organizationId, outcome.value.userId);
  return outcome.value;

  function redeemInTransaction(): Promise<RedeemOutcome> {
    return withOrgContext(
      db,
      { organizationId: req.organizationId, userId },
      async (scoped): Promise<RedeemOutcome> => {
        const tx = scoped as unknown as DbClient;
        const refuse = async (
          link: Pick<AuditorLinkRow, "id" | "engagementId">,
          reason: AuditorRefusalReason,
        ): Promise<RefusedOutcome> => {
          await auditRefusal(tx, req, link, reason);
          return { ok: false, reason };
        };

        const link = await findAuditorLinkByToken(tx, req.organizationId, req.token, {
          lock: true,
        });
        if (!link) return { ok: false, reason: "unknown_link" };
        const state = classifyAuditorLink(link, now);
        if (state !== "live") return refuse(link, state);

        const [membership] = await tx
          .select({ id: schema.memberships.id, status: schema.memberships.status })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.userId, userId),
              eq(schema.memberships.organizationId, req.organizationId),
              ne(schema.memberships.status, "revoked"),
            ),
          )
          .limit(1);
        if (membership && membership.status !== "active") {
          return refuse(link, "membership_not_active");
        }

        const refusal = await deps.access.check(tx, {
          organizationId: req.organizationId,
          engagementId: link.engagementId,
          membershipId: membership?.id ?? null,
          at: now,
        });
        if (refusal) return refuse(link, refusal);

        // Single use: matched on the row id AND the live predicate; a lost race reports `consumed`.
        if (!(await consumeAuditorLinkRow(tx, link, now))) return refuse(link, "consumed");

        // The link was delivered to this mailbox only: redeeming it proves control of the address.
        await tx
          .update(schema.users)
          .set({ emailVerified: true, updatedAt: now })
          .where(and(eq(schema.users.id, userId), eq(schema.users.emailVerified, false)));

        let membershipId = membership?.id;
        if (!membershipId) {
          const [created] = await tx
            .insert(schema.memberships)
            .values({
              userId,
              organizationId: req.organizationId,
              status: "active",
              acceptedAt: now,
              defaultLocationIds: [],
            })
            .returning({ id: schema.memberships.id });
          if (!created) throw new Error("auditor membership insert returned no row");
          membershipId = created.id;
        }

        // "No concurrent auditor sessions" (§2.2.4): the newest redemption wins.
        await db
          .delete(schema.sessions)
          .where(
            and(eq(schema.sessions.userId, userId), eq(schema.sessions.sessionClass, "auditor")),
          );

        let issued: IssuedAuditorSession;
        try {
          issued = await deps.sessions.issue({
            userId,
            organizationId: req.organizationId,
            engagementId: link.engagementId,
            windowStart: link.windowStart,
            windowEnd: link.expiresAt,
            now,
            ...(req.ip ? { ipAddress: req.ip } : {}),
            ...(req.userAgent ? { userAgent: req.userAgent } : {}),
          });
        } catch (error) {
          // Nothing is committed (the throw rolls the consume back), so the link stays redeemable.
          throw new ChartWardenError(
            "AUDITOR_SESSION_UNAVAILABLE",
            error instanceof Error ? error.message : "the auditor session could not be created",
            503,
          );
        }

        mintedSessionId = issued.sessionId;
        await audit(tx, auditCtx(req, userId), {
          eventType: "m2.auditor_link.redeemed",
          resourceKind: "auditor_magic_link",
          resourceId: link.id,
          outcome: "success",
          retentionClass: "compliance",
          context: {
            organizationId: req.organizationId,
            engagementId: link.engagementId,
            sessionId: issued.sessionId,
            membershipId,
            windowEnd: link.expiresAt.toISOString(),
          },
        });
        return {
          ok: true,
          value: {
            sessionId: issued.sessionId,
            userId,
            organizationId: req.organizationId,
            engagementId: link.engagementId,
            expiresAt: issued.expiresAt,
            setCookie: issued.setCookie,
          },
        };
      },
    );
  }
}

/** Audit a refusal of a real link in its OWN committed transaction (used before the main one opens). */
async function recordRefusal(
  db: DbClient,
  req: AuditorRedemptionRequest,
  link: Pick<AuditorLinkRow, "id" | "engagementId">,
  reason: AuditorRefusalReason,
): Promise<void> {
  await withOrgContext(db, { organizationId: req.organizationId, userId: "" }, (tx) =>
    auditRefusal(tx as unknown as DbClient, req, link, reason),
  );
}

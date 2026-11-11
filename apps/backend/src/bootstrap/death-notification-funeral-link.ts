// apps/backend/src/bootstrap/death-notification-funeral-link.ts - composition-root adapter for M36's `FuneralLinkPort`: mint and deliver the EXISTING M2
// funeral-home magic link (the same store, the same 72 h session class and the same fixed PHI-free email as `POST /funeral/invite`). M36 imports nothing
// from M2, so the pieces arrive structurally. Fail closed: the patient must be deceased, the actor must hold an active membership, and a delivery
// failure revokes the freshly minted link (no unreachable live credential is left behind). The address is used once and never stored here.
// The link is bound to the funeral home it was minted for (re-checked at redemption), and the SAME M2 audit event and `m2.funeral.invited` as
// `POST /funeral/invite` are recorded BEFORE delivery (an unrecorded disclosure is revoked, not sent); refused/blocked disclosures are audited too.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import { FuneralLinkIssueError } from "../modules/36-messaging/death-notification/death-notification-service";

type FuneralLinkCreated = { linkId: string; token?: string | undefined; expiresAt: string };

export interface FuneralLinkStorePort {
  create(input: {
    organizationId: string;
    patientId: string;
    invitedByMembershipId: string;
    kind: "funeral_home";
    sessionTtlSec: number;
    funeralHomeEntityId: string;
    disclosureAttemptId: string;
  }): Promise<FuneralLinkCreated> | FuneralLinkCreated;
  revoke(scope: { organizationId: string; linkId: string }): Promise<void>;
}

export interface FuneralLinkDeliveryPort {
  deliver(input: {
    kind: "funeral_home";
    organizationId: string;
    email: string;
    token: string;
    expiresAt: Date;
  }): Promise<void>;
}

/** The M2 audit + event trail of a funeral-home disclosure (structural: M36 and this root import no M2 internals). */
export interface FuneralDisclosureRecorderPort {
  invited(a: {
    orgId: string;
    actorUserId: string;
    patientId: string;
    linkId: string;
    correlationId?: string | undefined;
  }): Promise<void>;
  refused(a: {
    orgId: string;
    actorUserId: string;
    patientId: string;
    funeralHomeEntityId: string;
    reason: "unknown_funeral_home" | "no_baa" | "recipient_changed" | "caseload_denied";
    correlationId?: string | undefined;
  }): Promise<void>;
  /**
   * The link was minted (and `invited` recorded) but could not be delivered, so it was revoked: `m2.funeral.invited` records an ATTEMPTED
   * disclosure, this entry records that it did NOT complete. Ids only.
   */
  inviteRevoked(a: {
    orgId: string;
    actorUserId: string;
    patientId: string;
    linkId: string;
    correlationId?: string | undefined;
  }): Promise<void>;
}

export interface FuneralLinkPortInput {
  readonly db: DbClient;
  readonly collaborators: FuneralLinkStorePort;
  readonly delivery: FuneralLinkDeliveryPort | undefined;
  readonly isDeceased: (organizationId: string, patientId: string) => Promise<boolean>;
  readonly isBaaActive: (
    organizationId: string,
    kind: "funeral_home",
    entityId: string,
    asOf: Date,
  ) => Promise<boolean>;
  readonly sessionTtlSec: number;
  readonly recorder: FuneralDisclosureRecorderPort;
  /** Test override; production reads the active membership from the database. */
  readonly activeMembershipId?:
    | ((organizationId: string, userId: string) => Promise<string | null>)
    | undefined;
}

const SYSTEM_USER_ID = "";

async function activeMembershipId(
  db: DbClient,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const MB = schema.memberships;
  const rows = await withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
    tx
      .select({ id: MB.id })
      .from(MB)
      .where(
        and(eq(MB.organizationId, organizationId), eq(MB.userId, userId), eq(MB.status, "active")),
      )
      .limit(1),
  );
  return rows[0]?.id ?? null;
}

const LINKS = schema.collaboratorLinks;

/** Revoke only the still-live funeral link minted by this M36 disclosure attempt, plus its pinned id when known. */
async function revokeOrphanLinks(
  input: FuneralLinkPortInput,
  a: {
    orgId: string;
    disclosureAttemptId: string;
    linkId: string | null;
  },
): Promise<number> {
  const rows = await withOrgContext(
    input.db,
    { organizationId: a.orgId, userId: SYSTEM_USER_ID },
    (tx) =>
      tx
        .select({ id: LINKS.id })
        .from(LINKS)
        .where(
          and(
            eq(LINKS.organizationId, a.orgId),
            eq(LINKS.disclosureAttemptId, a.disclosureAttemptId),
            isNull(LINKS.revokedAt),
          ),
        ),
  );
  const ids = new Set(rows.map((r) => r.id));
  if (a.linkId) ids.add(a.linkId); // revoke is idempotent and org-scoped
  for (const linkId of ids) await input.collaborators.revoke({ organizationId: a.orgId, linkId });
  return ids.size;
}

/** Undefined when the delivery channel (the bound transactional email provider) is absent: the notice route then answers 503 and sends nothing. */
export function buildFuneralLinkPort(input: FuneralLinkPortInput) {
  const { delivery } = input;
  if (!delivery) return undefined;
  return {
    refused: (a: Parameters<FuneralDisclosureRecorderPort["refused"]>[0]) =>
      input.recorder.refused(a),
    revokeOrphans: (a: Parameters<typeof revokeOrphanLinks>[1]) => revokeOrphanLinks(input, a),
    async issue(a: {
      orgId: string;
      patientId: string;
      actorUserId: string;
      recipientEmail: string;
      funeralHomeEntityId: string;
      disclosureAttemptId: string;
      correlationId?: string | undefined;
      pinLink(linkId: string): Promise<boolean>;
    }): Promise<{ linkId: string }> {
      if (!(await input.isDeceased(a.orgId, a.patientId))) {
        throw new Error("funeral link refused: the patient is not deceased");
      }
      const membershipId = await (
        input.activeMembershipId ?? ((o, u) => activeMembershipId(input.db, o, u))
      )(a.orgId, a.actorUserId);
      if (!membershipId) throw new Error("funeral link refused: no active membership");
      const link = await input.collaborators.create({
        organizationId: a.orgId,
        patientId: a.patientId,
        invitedByMembershipId: membershipId,
        kind: "funeral_home",
        sessionTtlSec: input.sessionTtlSec,
        funeralHomeEntityId: a.funeralHomeEntityId,
        disclosureAttemptId: a.disclosureAttemptId,
      });
      const revokeAfterFailure = async (
        message: string,
        reason: "no_baa" | "other" = "other",
      ): Promise<never> => {
        try {
          await input.collaborators.revoke({ organizationId: a.orgId, linkId: link.linkId });
        } catch {
          throw new FuneralLinkIssueError(message, false, reason);
        }
        await (reason === "no_baa"
          ? input.recorder.refused({
              orgId: a.orgId,
              actorUserId: a.actorUserId,
              patientId: a.patientId,
              funeralHomeEntityId: a.funeralHomeEntityId,
              reason: "no_baa",
              correlationId: a.correlationId,
            })
          : input.recorder.inviteRevoked({
              orgId: a.orgId,
              actorUserId: a.actorUserId,
              patientId: a.patientId,
              linkId: link.linkId,
              correlationId: a.correlationId,
            })
        ).catch(() => undefined);
        throw new FuneralLinkIssueError(message, true, reason);
      };
      if (!link.token)
        return revokeAfterFailure("funeral link refused: the store returned no token");
      try {
        if (!(await a.pinLink(link.linkId)))
          return revokeAfterFailure("funeral link refused: the send fence was lost");
        await input.recorder.invited({
          orgId: a.orgId,
          actorUserId: a.actorUserId,
          patientId: a.patientId,
          linkId: link.linkId,
          correlationId: a.correlationId,
        });
        const baaInForce = await input
          .isBaaActive(a.orgId, "funeral_home", a.funeralHomeEntityId, new Date())
          .catch(() => false);
        if (!baaInForce)
          return revokeAfterFailure(
            "funeral link refused: the BAA is no longer in force",
            "no_baa",
          );
        if (!(await a.pinLink(link.linkId)))
          return revokeAfterFailure("funeral link refused: reconciliation owns the send");
        await delivery.deliver({
          kind: "funeral_home",
          organizationId: a.orgId,
          email: a.recipientEmail,
          token: link.token,
          expiresAt: new Date(link.expiresAt),
        });
      } catch (err) {
        if (err instanceof FuneralLinkIssueError) throw err;
        return revokeAfterFailure(
          err instanceof Error ? err.message : "funeral link delivery failed",
        );
      }
      return { linkId: link.linkId };
    },
  };
}

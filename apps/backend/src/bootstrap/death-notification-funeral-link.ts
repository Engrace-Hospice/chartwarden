// apps/backend/src/bootstrap/death-notification-funeral-link.ts - composition-root adapter for M36's `FuneralLinkPort`: mint and deliver the EXISTING M2
// funeral-home magic link (the same store, the same 72 h session class and the same fixed PHI-free email as `POST /funeral/invite`). M36 imports nothing
// from M2, so the pieces arrive structurally. Fail closed: the patient must be deceased, the actor must hold an active membership, and a delivery
// failure revokes the freshly minted link (no unreachable live credential is left behind). The address is used once and never stored here.
// The link is bound to the funeral home it was minted for (re-checked at redemption), and the SAME M2 audit event and `m2.funeral.invited` as
// `POST /funeral/invite` are recorded BEFORE delivery (an unrecorded disclosure is revoked, not sent); refused/blocked disclosures are audited too.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

type FuneralLinkCreated = { linkId: string; token?: string | undefined; expiresAt: string };

export interface FuneralLinkStorePort {
  create(input: {
    organizationId: string;
    patientId: string;
    invitedByMembershipId: string;
    kind: "funeral_home";
    sessionTtlSec: number;
    funeralHomeEntityId: string;
  }): Promise<FuneralLinkCreated> | FuneralLinkCreated;
  revoke?(scope: { organizationId: string; linkId: string }): Promise<void>;
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
    reason: "unknown_funeral_home" | "no_baa";
    correlationId?: string | undefined;
  }): Promise<void>;
}

export interface FuneralLinkPortInput {
  readonly db: DbClient;
  readonly collaborators: FuneralLinkStorePort;
  readonly delivery: FuneralLinkDeliveryPort | undefined;
  readonly isDeceased: (organizationId: string, patientId: string) => Promise<boolean>;
  readonly sessionTtlSec: number;
  readonly recorder: FuneralDisclosureRecorderPort;
  /** Test override; production reads the active membership from the database. */
  readonly activeMembershipId?: ((organizationId: string, userId: string) => Promise<string | null>) | undefined;
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

/** Undefined when the delivery channel (the bound transactional email provider) is absent: the notice route then answers 503 and sends nothing. */
export function buildFuneralLinkPort(input: FuneralLinkPortInput) {
  const { delivery } = input;
  if (!delivery) return undefined;
  return {
    refused: (a: Parameters<FuneralDisclosureRecorderPort["refused"]>[0]) => input.recorder.refused(a),
    async issue(a: {
      orgId: string;
      patientId: string;
      actorUserId: string;
      recipientEmail: string;
      funeralHomeEntityId: string;
      correlationId?: string | undefined;
    }): Promise<{ linkId: string }> {
      if (!(await input.isDeceased(a.orgId, a.patientId))) {
        throw new Error("funeral link refused: the patient is not deceased");
      }
      const membershipId = await (input.activeMembershipId ?? ((o, u) => activeMembershipId(input.db, o, u)))(
        a.orgId,
        a.actorUserId,
      );
      if (!membershipId) throw new Error("funeral link refused: no active membership");
      const link = await input.collaborators.create({
        organizationId: a.orgId,
        patientId: a.patientId,
        invitedByMembershipId: membershipId,
        kind: "funeral_home",
        sessionTtlSec: input.sessionTtlSec,
        funeralHomeEntityId: a.funeralHomeEntityId,
      });
      if (!link.token) throw new Error("funeral link refused: the store returned no token");
      try {
        await input.recorder.invited({
          orgId: a.orgId,
          actorUserId: a.actorUserId,
          patientId: a.patientId,
          linkId: link.linkId,
          correlationId: a.correlationId,
        });
        await delivery.deliver({
          kind: "funeral_home",
          organizationId: a.orgId,
          email: a.recipientEmail,
          token: link.token,
          expiresAt: new Date(link.expiresAt),
        });
      } catch (err) {
        await input.collaborators.revoke?.({ organizationId: a.orgId, linkId: link.linkId });
        throw err;
      }
      return { linkId: link.linkId };
    },
  };
}

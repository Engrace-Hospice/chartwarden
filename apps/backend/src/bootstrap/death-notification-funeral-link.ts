// apps/backend/src/bootstrap/death-notification-funeral-link.ts - composition-root adapter for M36's `FuneralLinkPort`: mint and deliver the EXISTING M2
// funeral-home magic link (the same store, the same 72 h session class and the same fixed PHI-free email as `POST /funeral/invite`). M36 imports nothing
// from M2, so the pieces arrive structurally. Fail closed: the patient must be deceased, the actor must hold an active membership, and a delivery
// failure revokes the freshly minted link (no unreachable live credential is left behind). The address is used once and never stored here.
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

export interface FuneralLinkPortInput {
  readonly db: DbClient;
  readonly collaborators: FuneralLinkStorePort;
  readonly delivery: FuneralLinkDeliveryPort | undefined;
  readonly isDeceased: (organizationId: string, patientId: string) => Promise<boolean>;
  readonly sessionTtlSec: number;
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
    async issue(a: { orgId: string; patientId: string; actorUserId: string; recipientEmail: string }) {
      if (!(await input.isDeceased(a.orgId, a.patientId))) {
        throw new Error("funeral link refused: the patient is not deceased");
      }
      const membershipId = await activeMembershipId(input.db, a.orgId, a.actorUserId);
      if (!membershipId) throw new Error("funeral link refused: no active membership");
      const link = await input.collaborators.create({
        organizationId: a.orgId,
        patientId: a.patientId,
        invitedByMembershipId: membershipId,
        kind: "funeral_home",
        sessionTtlSec: input.sessionTtlSec,
      });
      if (!link.token) throw new Error("funeral link refused: the store returned no token");
      try {
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
    },
  };
}

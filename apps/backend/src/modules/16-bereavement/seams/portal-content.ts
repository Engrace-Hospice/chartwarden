// apps/backend/src/modules/16-bereavement/seams/portal-content.ts — ADR-0109 D10 (PR 3): the `BereavementPortalContentProvider` M16 publishes for M31.
//
// What a bereaved family sees in the portal beyond its plan scope: its OWN memorial invitations (contacts whose `portal_account_id` is the session's
// account) and its own RSVP. M31's route gates the bereavement window (`bereaved_portal_window_open`) and the `portal.bereavement.*` key; M16 decides
// which rows are the account's. Only PUBLISHED services are shown. A virtual service's link is revealed once the family said yes. Every read and write
// runs under `withOrgContext` with the portal user (RLS on `app.org_id`; the audit trigger records the actor).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  BereavementMemorialInvitationStatus,
  BereavementPortalContentProvider,
  BereavementPortalMemorialInvitation,
  IsoInstant,
} from "@chartwarden/types";
import { and, asc, eq } from "drizzle-orm";
import type { BereavementCipher } from "../bereavement-crypto";
import { applyMemorialRsvp, rsvpWindowOpen } from "../memorials/rsvp-drizzle";
import type { WriteOutboxPort } from "../routes/write-service";

type InvitationRow = typeof schema.bereavementMemorialInvitation.$inferSelect;
type ServiceRow = typeof schema.bereavementMemorialService.$inferSelect;

export interface BereavementPortalContentDeps {
  /** The catalog-validating tx publisher bound to `m16` (the RSVP emits `memorial_rsvp_recorded`). */
  readonly outbox: WriteOutboxPort;
  /** Opens a virtual service's link. Unbound => no link is shown. */
  readonly cipher?: BereavementCipher;
  readonly now?: () => Date;
}

export function createBereavementPortalContentProvider(
  db: DbClient,
  deps: BereavementPortalContentDeps,
): BereavementPortalContentProvider {
  const INV = schema.bereavementMemorialInvitation;
  const SVC = schema.bereavementMemorialService;
  const CONTACT = schema.bereavedContact;
  const now = deps.now ?? (() => new Date());

  async function toPortal(
    inv: InvitationRow,
    svc: ServiceRow,
    at: Date,
  ): Promise<BereavementPortalMemorialInvitation> {
    const revealLink =
      inv.status === "rsvp_yes" && svc.joinUrlCipher !== null && deps.cipher !== undefined;
    return {
      invitationId: inv.id,
      title: svc.title,
      description: svc.description ?? null,
      startsAt: svc.startsAt.toISOString() as IsoInstant,
      endsAt: svc.endsAt.toISOString() as IsoInstant,
      modality: svc.modality,
      venueText: svc.venueText ?? null,
      joinUrl:
        revealLink && svc.joinUrlCipher !== null && deps.cipher !== undefined
          ? await deps.cipher.decrypt(
              svc.organizationId,
              "bereavement_memorial_service.join_url",
              svc.joinUrlCipher,
            )
          : null,
      rsvpBy: svc.rsvpBy ?? null,
      status: inv.status as BereavementMemorialInvitationStatus,
      guests: inv.guests,
      rsvpOpen:
        ["invited", "rsvp_yes", "rsvp_no", "rsvp_maybe"].includes(inv.status) &&
        rsvpWindowOpen({ ...svc, rsvpBy: svc.rsvpBy ?? null }, "portal", at),
    };
  }

  return {
    async memorialInvitationsForPortalAccount({ organizationId, userId, portalAccountId }) {
      const at = now();
      return withOrgContext(db, { organizationId, userId }, async (scoped) => {
        const tx = scoped as DbClient;
        const rows = await tx
          .select({ inv: INV, svc: SVC })
          .from(INV)
          .innerJoin(SVC, eq(SVC.id, INV.serviceId))
          .innerJoin(CONTACT, eq(CONTACT.id, INV.bereavedContactId))
          .where(and(eq(CONTACT.portalAccountId, portalAccountId), eq(SVC.status, "published")))
          .orderBy(asc(SVC.startsAt), asc(INV.id))
          .limit(50);
        return Promise.all(rows.map((r) => toPortal(r.inv, r.svc, at)));
      });
    },

    async recordPortalRsvp({
      organizationId,
      userId,
      portalAccountId,
      invitationId,
      response,
      guests,
    }) {
      const at = now();
      return withOrgContext(db, { organizationId, userId }, async (scoped) => {
        const { invitation, service } = await applyMemorialRsvp(scoped as DbClient, {
          organizationId,
          invitationId,
          portalAccountId,
          response,
          guests,
          source: "portal",
          recordedByMembershipId: null,
          at,
          outbox: deps.outbox,
        });
        return toPortal(invitation, service, at);
      });
    },
  };
}

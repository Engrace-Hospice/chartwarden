// apps/backend/src/modules/16-bereavement/memorials/rsvp-drizzle.ts — ADR-0109 D10 (PR 3): record a memorial RSVP (staff phone or the family's portal).
//
// ONE rule for both doors, inside the caller's transaction:
//   * the invitation must belong to the named contact (staff) or to a contact on the named portal account (portal); anything else is "not found";
//   * the service must be `published` and not yet started; the PORTAL also stops at the RSVP-by date (staff may still take a late call);
//   * an invitation that was withdrawn or already marked attended / no-show is closed;
//   * a `yes` must fit the capacity: the service row is LOCKED, so two answers cannot both take the last seats (people = 1 + guests per yes);
//   * `guests` counts only on a yes (a no / maybe stores 0). `memorial_rsvp_recorded` (ids, tokens, a count) is published on the same transaction.
import { type DbClient, schema } from "@chartwarden/db";
import type {
  BereavementMemorialRsvpResponse,
  BereavementMemorialRsvpSource,
} from "@chartwarden/types";
import { and, eq, ne, sql } from "drizzle-orm";
import { BereavementStateError } from "../lifecycle/index";
import type { WriteOutboxPort } from "../routes/write-service";

type InvitationRow = typeof schema.bereavementMemorialInvitation.$inferSelect;
type ServiceRow = typeof schema.bereavementMemorialService.$inferSelect;

const ANSWERABLE = new Set(["invited", "rsvp_yes", "rsvp_no", "rsvp_maybe"]);

/** Pure: may this source still answer? (`today` and `rsvpBy` are `YYYY-MM-DD`.) */
export function rsvpWindowOpen(
  service: { readonly status: string; readonly startsAt: Date; readonly rsvpBy: string | null },
  source: BereavementMemorialRsvpSource,
  at: Date,
): boolean {
  if (service.status !== "published") return false;
  if (at.getTime() >= service.startsAt.getTime()) return false;
  if (source === "portal" && service.rsvpBy !== null) {
    return at.toISOString().slice(0, 10) <= service.rsvpBy;
  }
  return true;
}

export async function applyMemorialRsvp(
  tx: DbClient,
  args: {
    readonly organizationId: string;
    readonly invitationId: string;
    /** Staff door: the invitation must be this contact's. */
    readonly contactId?: string;
    /** Portal door: the invitation's contact must be on this account. */
    readonly portalAccountId?: string;
    readonly response: BereavementMemorialRsvpResponse;
    readonly guests: number;
    readonly source: BereavementMemorialRsvpSource;
    readonly recordedByMembershipId: string | null;
    readonly at: Date;
    readonly outbox: WriteOutboxPort;
  },
): Promise<{ readonly invitation: InvitationRow; readonly service: ServiceRow }> {
  const INV = schema.bereavementMemorialInvitation;
  const SVC = schema.bereavementMemorialService;
  const CONTACT = schema.bereavedContact;
  const notFound = () =>
    new BereavementStateError("MEMORIAL_INVITATION_NOT_FOUND", "invitation not found");

  const [found] = await tx
    .select({ inv: INV, portalAccountId: CONTACT.portalAccountId })
    .from(INV)
    .innerJoin(CONTACT, eq(CONTACT.id, INV.bereavedContactId))
    .where(eq(INV.id, args.invitationId))
    .limit(1);
  if (!found) throw notFound();
  if (args.contactId !== undefined && found.inv.bereavedContactId !== args.contactId) {
    throw notFound();
  }
  if (args.portalAccountId !== undefined && found.portalAccountId !== args.portalAccountId) {
    throw notFound();
  }
  // Lock the service: the capacity check and the update below are one decision.
  const [service] = await tx
    .select()
    .from(SVC)
    .where(eq(SVC.id, found.inv.serviceId))
    .limit(1)
    .for("update");
  if (!service) throw notFound();
  const [inv] = await tx.select().from(INV).where(eq(INV.id, args.invitationId)).limit(1);
  if (!inv) throw notFound();

  if (service.status !== "published") {
    throw new BereavementStateError("MEMORIAL_NOT_OPEN", `this service is ${service.status}`);
  }
  if (!rsvpWindowOpen({ ...service, rsvpBy: service.rsvpBy ?? null }, args.source, args.at)) {
    throw new BereavementStateError(
      "MEMORIAL_RSVP_CLOSED",
      "this service is no longer taking replies here; please contact your hospice team",
    );
  }
  if (!ANSWERABLE.has(inv.status)) {
    throw new BereavementStateError("MEMORIAL_NOT_OPEN", `this invitation is ${inv.status}`);
  }
  const guests = args.response === "yes" ? args.guests : 0;
  if (args.response === "yes" && service.capacity !== null) {
    const [{ people } = { people: 0 }] = await tx
      .select({ people: sql<number>`coalesce(sum(1 + ${INV.guests}), 0)::int` })
      .from(INV)
      .where(and(eq(INV.serviceId, service.id), eq(INV.status, "rsvp_yes"), ne(INV.id, inv.id)));
    if (people + 1 + guests > service.capacity) {
      throw new BereavementStateError(
        "MEMORIAL_FULL",
        "this service has no room for that many people",
      );
    }
  }
  const [row] = await tx
    .update(INV)
    .set({
      status: `rsvp_${args.response}` as const,
      guests,
      rsvpSource: args.source,
      rsvpAt: args.at,
      rsvpRecordedByMembershipId: args.recordedByMembershipId,
      version: inv.version + 1,
      updatedAt: args.at,
    })
    .where(and(eq(INV.id, inv.id), eq(INV.version, inv.version)))
    .returning();
  if (!row) {
    throw new BereavementStateError(
      "STALE_VERSION",
      "the invitation has moved on; re-read it and retry",
    );
  }
  await args.outbox.publish(tx, {
    organizationId: args.organizationId,
    eventName: "m16.bereavement.memorial_rsvp_recorded",
    aggregateKind: "bereavement_memorial_service",
    aggregateId: service.id,
    payload: {
      serviceId: service.id,
      invitationId: row.id,
      response: args.response,
      guests,
      source: args.source,
    },
  });
  return { invitation: row, service };
}

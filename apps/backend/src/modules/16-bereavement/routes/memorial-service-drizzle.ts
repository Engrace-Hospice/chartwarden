// apps/backend/src/modules/16-bereavement/routes/memorial-service-drizzle.ts — the Drizzle-backed memorial-service service (ADR-0109 D10, PR 3).
//
// Every method runs inside one `withOrgContext` transaction (RLS on `app.org_id`); state changes are compare-and-set on `version` + status, with
// `If-Match` naming the version read.
//
//   publish     draft -> published; the invitations are selected SET-BASED and the invitation mailing run drafted (`memorials/publish-drizzle.ts`).
//   close       published -> held (once it has started) | draft / published -> cancelled (an unmailed invitation run is cancelled with it).
//   rsvp        `memorials/rsvp-drizzle.ts` (the one rule the portal door uses too).
//   attendance  once the service has started: `attended` writes a contact-log ACTIVITY row (`memorial_service_attendance`, outcome `attended`,
//               contact_at = the service start, id = the invitation id) on the same transaction; `no_show` writes nothing. Attended is final.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  BereavedContactRelationship,
  BereavementMemorialInvitationStatus,
  BereavementMemorialRsvpSource,
} from "@chartwarden/types";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { BereavementCipher } from "../bereavement-crypto";
import { BereavementStateError, checkVersion } from "../lifecycle/index";
import { cancelUnmailedMemorialRun, inviteForMemorial } from "../memorials/publish-drizzle";
import { applyMemorialRsvp } from "../memorials/rsvp-drizzle";
import type { M16ReadActor } from "./actor";
import { type Cursor, clampLimit, decodeCheckedCursor, toCursorPage } from "./concurrency";
import type {
  ContactMemorialInvitationView,
  M16MemorialService,
  MemorialDetailView,
  MemorialFieldsInput,
  MemorialInvitationView,
  MemorialRsvpCounts,
  MemorialView,
} from "./memorial-service";
import type { WriteOutboxPort } from "./write-service";

type ServiceRow = typeof schema.bereavementMemorialService.$inferSelect;
type InvitationRow = typeof schema.bereavementMemorialInvitation.$inferSelect;

const PAGE = { defaultSize: 25, maxSize: 100 } as const;
const MAX_INVITATIONS = 2000;

export interface M16MemorialDeps {
  readonly outbox: WriteOutboxPort;
  /** Seals / opens the meeting link. Unbound => a link cannot be stored and reads show none. */
  readonly cipher?: BereavementCipher;
  readonly now?: () => Date;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const ZERO: MemorialRsvpCounts = {
  invited: 0,
  yes: 0,
  no: 0,
  maybe: 0,
  attended: 0,
  noShow: 0,
  guestsExpected: 0,
};

export function buildDrizzleM16MemorialService(
  db: DbClient,
  deps: M16MemorialDeps,
): M16MemorialService {
  const SVC = schema.bereavementMemorialService;
  const INV = schema.bereavementMemorialInvitation;
  const CONTACT = schema.bereavedContact;
  const LOG = schema.bereavementContactLog;
  const now = deps.now ?? (() => new Date());
  const scope = (actor: M16ReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });
  const asTx = (scoped: unknown): DbClient => scoped as DbClient;
  const stale = () =>
    new BereavementStateError(
      "STALE_VERSION",
      "the memorial service has moved on; re-read it and retry",
    );

  async function serviceOr404(tx: DbClient, id: string, lock = false): Promise<ServiceRow> {
    const q = tx.select().from(SVC).where(eq(SVC.id, id)).limit(1);
    const [row] = await (lock ? q.for("update") : q);
    if (!row) throw new BereavementStateError("MEMORIAL_NOT_FOUND", "memorial service not found");
    return row;
  }

  async function countsFor(tx: DbClient, ids: readonly string[]) {
    const out = new Map<string, MemorialRsvpCounts>();
    if (ids.length === 0) return out;
    const rows = await tx
      .select({
        serviceId: INV.serviceId,
        status: INV.status,
        n: sql<number>`count(*)::int`,
        guests: sql<number>`coalesce(sum(${INV.guests}), 0)::int`,
      })
      .from(INV)
      .where(inArray(INV.serviceId, [...ids]))
      .groupBy(INV.serviceId, INV.status);
    for (const r of rows) {
      const c = out.get(r.serviceId) ?? ZERO;
      out.set(r.serviceId, {
        invited: c.invited + (r.status === "invited" ? r.n : 0),
        yes: c.yes + (r.status === "rsvp_yes" ? r.n : 0),
        no: c.no + (r.status === "rsvp_no" ? r.n : 0),
        maybe: c.maybe + (r.status === "rsvp_maybe" ? r.n : 0),
        attended: c.attended + (r.status === "attended" ? r.n : 0),
        noShow: c.noShow + (r.status === "no_show" ? r.n : 0),
        guestsExpected: c.guestsExpected + (r.status === "rsvp_yes" ? r.guests : 0),
      });
    }
    return out;
  }

  function view(row: ServiceRow, counts: MemorialRsvpCounts): MemorialView {
    return {
      serviceId: row.id,
      title: row.title,
      description: row.description ?? null,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      modality: row.modality,
      venueText: row.venueText ?? null,
      hasJoinUrl: row.joinUrlCipher !== null,
      capacity: row.capacity ?? null,
      rsvpBy: row.rsvpBy ?? null,
      inviteWindowMonths: row.inviteWindowMonths,
      status: row.status,
      publishedAt: iso(row.publishedAt),
      invitedCount: row.invitedCount,
      rsvpCounts: counts,
      mailingRunId: row.mailingRunId ?? null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async function detail(tx: DbClient, row: ServiceRow): Promise<MemorialDetailView> {
    const counts = (await countsFor(tx, [row.id])).get(row.id) ?? ZERO;
    const joinUrl =
      row.joinUrlCipher !== null && deps.cipher !== undefined
        ? await deps.cipher.decrypt(
            row.organizationId,
            "bereavement_memorial_service.join_url",
            row.joinUrlCipher,
          )
        : null;
    return { ...view(row, counts), joinUrl };
  }

  function assertFields(input: MemorialFieldsInput): void {
    if (!(Date.parse(input.endsAt) > Date.parse(input.startsAt))) {
      throw new BereavementStateError(
        "MEMORIAL_NOT_EDITABLE",
        "a service must end after it starts",
      );
    }
    if (input.rsvpBy !== null && input.rsvpBy > input.startsAt.slice(0, 10)) {
      throw new BereavementStateError(
        "MEMORIAL_NOT_EDITABLE",
        "the RSVP-by date must not be after the service",
      );
    }
  }

  async function sealJoinUrl(orgId: string, joinUrl: string | null | undefined) {
    if (joinUrl === undefined || joinUrl === null) return joinUrl;
    if (deps.cipher === undefined) {
      throw new BereavementStateError(
        "MEMORIAL_NOT_EDITABLE",
        "a meeting link cannot be stored: no tenant key is bound",
      );
    }
    return deps.cipher.encrypt(orgId, "bereavement_memorial_service.join_url", joinUrl);
  }

  function fieldValues(input: MemorialFieldsInput) {
    return {
      title: input.title,
      description: input.description,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      modality: input.modality,
      venueText: input.venueText,
      capacity: input.capacity,
      rsvpBy: input.rsvpBy,
      inviteWindowMonths: input.inviteWindowMonths,
    };
  }

  function invitationView(
    r: InvitationRow,
    contact: { displayName: string; relationshipCode: string },
  ): MemorialInvitationView {
    return {
      invitationId: r.id,
      serviceId: r.serviceId,
      contactId: r.bereavedContactId,
      planId: r.planId,
      displayName: contact.displayName,
      relationshipCode: contact.relationshipCode as BereavedContactRelationship,
      delivery: r.delivery,
      status: r.status as BereavementMemorialInvitationStatus,
      guests: r.guests,
      rsvpSource: (r.rsvpSource ?? null) as BereavementMemorialRsvpSource | null,
      rsvpAt: iso(r.rsvpAt),
      attendedAt: iso(r.attendedAt),
      version: r.version,
    };
  }

  function contactInvitationView(r: InvitationRow, s: ServiceRow): ContactMemorialInvitationView {
    return {
      invitationId: r.id,
      serviceId: s.id,
      serviceTitle: s.title,
      startsAt: s.startsAt.toISOString(),
      serviceStatus: s.status,
      delivery: r.delivery,
      status: r.status as BereavementMemorialInvitationStatus,
      guests: r.guests,
      rsvpSource: (r.rsvpSource ?? null) as BereavementMemorialRsvpSource | null,
      rsvpAt: iso(r.rsvpAt),
      version: r.version,
    };
  }

  return {
    async listMemorials(actor, input) {
      const limit = clampLimit(input.limit, PAGE);
      const after: Cursor | null = decodeCheckedCursor(input.cursor, "instant");
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const rows = await tx
          .select()
          .from(SVC)
          .where(
            and(
              input.status === undefined ? undefined : eq(SVC.status, input.status),
              after === null
                ? undefined
                : or(
                    lt(SVC.startsAt, new Date(after.a)),
                    and(eq(SVC.startsAt, new Date(after.a)), lt(SVC.id, after.id)),
                  ),
            ),
          )
          .orderBy(desc(SVC.startsAt), desc(SVC.id))
          .limit(limit + 1);
        const counts = await countsFor(
          tx,
          rows.slice(0, limit).map((r) => r.id),
        );
        return toCursorPage(
          rows,
          limit,
          (r) => ({ a: r.startsAt.toISOString(), id: r.id }),
          (r) => view(r, counts.get(r.id) ?? ZERO),
        );
      });
    },

    async getMemorial(actor, serviceId) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [row] = await tx.select().from(SVC).where(eq(SVC.id, serviceId)).limit(1);
        return row ? detail(tx, row) : null;
      });
    },

    async createMemorial(actor, input) {
      assertFields(input);
      const joinUrlCipher = await sealJoinUrl(actor.organizationId, input.joinUrl);
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [row] = await tx
          .insert(SVC)
          .values({
            organizationId: actor.organizationId,
            ...fieldValues(input),
            joinUrlCipher: joinUrlCipher ?? null,
            createdByMembershipId: actor.membershipId,
            version: 1,
          })
          .returning();
        if (!row) throw new Error("memorial service insert returned no row");
        return detail(tx, row);
      });
    },

    async updateMemorial(actor, serviceId, input) {
      assertFields(input);
      const joinUrlCipher = await sealJoinUrl(actor.organizationId, input.joinUrl);
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const svc = await serviceOr404(tx, serviceId);
        checkVersion(input.expectedVersion, svc.version);
        if (svc.status !== "draft" && svc.status !== "published") {
          throw new BereavementStateError(
            "MEMORIAL_NOT_EDITABLE",
            `a ${svc.status} service can no longer be changed`,
          );
        }
        if (svc.status === "published" && input.inviteWindowMonths !== svc.inviteWindowMonths) {
          throw new BereavementStateError(
            "MEMORIAL_NOT_EDITABLE",
            "the invitation window is fixed once the invitations went out",
          );
        }
        const [row] = await tx
          .update(SVC)
          .set({
            ...fieldValues(input),
            ...(joinUrlCipher === undefined ? {} : { joinUrlCipher }),
            version: svc.version + 1,
            updatedAt: now(),
          })
          .where(and(eq(SVC.id, svc.id), eq(SVC.version, svc.version)))
          .returning();
        if (!row) throw stale();
        return detail(tx, row);
      });
    },

    async publishMemorial(actor, serviceId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const svc = await serviceOr404(tx, serviceId);
        checkVersion(input.expectedVersion, svc.version);
        if (svc.status !== "draft") {
          throw new BereavementStateError(
            "MEMORIAL_NOT_EDITABLE",
            `a ${svc.status} service cannot be published`,
          );
        }
        const at = now();
        if (svc.startsAt.getTime() <= at.getTime()) {
          throw new BereavementStateError(
            "MEMORIAL_NOT_EDITABLE",
            "a service in the past cannot be published",
          );
        }
        const [claimed] = await tx
          .update(SVC)
          .set({
            status: "published",
            publishedAt: at,
            publishedByMembershipId: actor.membershipId,
            version: svc.version + 1,
            updatedAt: at,
          })
          .where(and(eq(SVC.id, svc.id), eq(SVC.version, svc.version), eq(SVC.status, "draft")))
          .returning();
        if (!claimed) throw stale();
        const { invited, mailingRunId } = await inviteForMemorial(tx, claimed, at);
        const [row] = await tx
          .update(SVC)
          .set({ invitedCount: invited, mailingRunId })
          .where(eq(SVC.id, claimed.id))
          .returning();
        if (!row) throw stale();
        return detail(tx, row);
      });
    },

    async closeMemorial(actor, serviceId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const svc = await serviceOr404(tx, serviceId, true);
        checkVersion(input.expectedVersion, svc.version);
        const at = now();
        if (input.status === "held") {
          if (svc.status !== "published" || svc.startsAt.getTime() > at.getTime()) {
            throw new BereavementStateError(
              "MEMORIAL_NOT_OPEN",
              "only a published service that has started can be marked held",
            );
          }
        } else if (svc.status !== "draft" && svc.status !== "published") {
          throw new BereavementStateError(
            "MEMORIAL_NOT_EDITABLE",
            `a ${svc.status} service cannot be cancelled`,
          );
        }
        const [row] = await tx
          .update(SVC)
          .set({ status: input.status, closedAt: at, version: svc.version + 1, updatedAt: at })
          .where(and(eq(SVC.id, svc.id), eq(SVC.version, svc.version)))
          .returning();
        if (!row) throw stale();
        if (input.status === "cancelled") await cancelUnmailedMemorialRun(tx, row.mailingRunId, at);
        return detail(tx, row);
      });
    },

    async listInvitations(actor, serviceId) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [svc] = await tx
          .select({ id: SVC.id })
          .from(SVC)
          .where(eq(SVC.id, serviceId))
          .limit(1);
        if (!svc) return null;
        const rows = await tx
          .select({ inv: INV, displayName: CONTACT.displayName, rel: CONTACT.relationshipCode })
          .from(INV)
          .innerJoin(CONTACT, eq(CONTACT.id, INV.bereavedContactId))
          .where(eq(INV.serviceId, serviceId))
          .orderBy(asc(CONTACT.displayName), asc(INV.id))
          .limit(MAX_INVITATIONS);
        return rows.map((r) =>
          invitationView(r.inv, { displayName: r.displayName, relationshipCode: r.rel }),
        );
      });
    },

    async recordStaffRsvp(actor, contactId, invitationId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const { invitation, service } = await applyMemorialRsvp(asTx(scoped), {
          organizationId: actor.organizationId,
          invitationId,
          contactId,
          response: input.response,
          guests: input.guests,
          source: "staff_phone",
          recordedByMembershipId: actor.membershipId,
          at: now(),
          outbox: deps.outbox,
        });
        return contactInvitationView(invitation, service);
      });
    },

    async recordAttendance(actor, serviceId, invitationId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const svc = await serviceOr404(tx, serviceId);
        const at = now();
        if (
          (svc.status !== "published" && svc.status !== "held") ||
          svc.startsAt.getTime() > at.getTime()
        ) {
          throw new BereavementStateError(
            "MEMORIAL_NOT_OPEN",
            "attendance is recorded once a published service has started",
          );
        }
        const [found] = await tx
          .select({ inv: INV, displayName: CONTACT.displayName, rel: CONTACT.relationshipCode })
          .from(INV)
          .innerJoin(CONTACT, eq(CONTACT.id, INV.bereavedContactId))
          .where(and(eq(INV.id, invitationId), eq(INV.serviceId, svc.id)))
          .limit(1)
          .for("update", { of: INV });
        if (!found) {
          throw new BereavementStateError("MEMORIAL_INVITATION_NOT_FOUND", "invitation not found");
        }
        const inv = found.inv;
        const contact = { displayName: found.displayName, relationshipCode: found.rel };
        if (inv.status === "attended") {
          if (input.attended) return invitationView(inv, contact); // idempotent
          throw new BereavementStateError("MEMORIAL_NOT_EDITABLE", "attendance already recorded");
        }
        if (inv.status === "withdrawn") {
          throw new BereavementStateError("MEMORIAL_NOT_OPEN", "this invitation was withdrawn");
        }
        if (input.attended) {
          await tx
            .insert(LOG)
            .values({
              id: inv.id,
              organizationId: inv.organizationId,
              providerEntityId: inv.providerEntityId,
              locationId: inv.locationId,
              planId: inv.planId,
              bereavedContactId: inv.bereavedContactId,
              contactAt: svc.startsAt,
              outcome: "attended",
              activityKind: "memorial_service_attendance",
              activityRefId: svc.id,
              loggedByUserId: actor.membershipId,
              contactRespondedDirectly: false,
            })
            .onConflictDoNothing();
        }
        const [row] = await tx
          .update(INV)
          .set({
            status: input.attended ? "attended" : "no_show",
            attendedAt: input.attended ? at : null,
            logId: input.attended ? inv.id : null,
            version: inv.version + 1,
            updatedAt: at,
          })
          .where(and(eq(INV.id, inv.id), eq(INV.version, inv.version)))
          .returning();
        if (!row) throw stale();
        return invitationView(row, contact);
      });
    },

    async contactInvitations(actor, contactId) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [contact] = await tx
          .select({ id: CONTACT.id })
          .from(CONTACT)
          .where(eq(CONTACT.id, contactId))
          .limit(1);
        if (!contact) return null;
        const rows = await tx
          .select({ inv: INV, svc: SVC })
          .from(INV)
          .innerJoin(SVC, eq(SVC.id, INV.serviceId))
          .where(eq(INV.bereavedContactId, contactId))
          .orderBy(desc(SVC.startsAt))
          .limit(50);
        return rows.map((r) => contactInvitationView(r.inv, r.svc));
      });
    },
  };
}

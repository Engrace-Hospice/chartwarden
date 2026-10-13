// apps/backend/src/modules/36-messaging/announcement-service-db.ts — M36 WP 2.9 over Postgres.
//
//  - listAnnouncementReceipts: who has read one announcement. Recipients are the organization's active staff except the
//    author; readers are the `message_receipt` rows with status `read` (written by announcement-receipts.ts); unread is
//    the difference. Counts are exact, each list is capped at RECEIPT_LIST_LIMIT.
//  - createDepartmentChannel: find-or-create the `location` / `discipline` channel for a subject, after checking the
//    subject belongs to the organization. The creator becomes its owner; further membership uses the member-admin routes.
//  - isAnnouncementChannel: the probe behind the org_admin-only send guard.
// Every statement runs under withOrgContext (RLS on app.org_id is the backstop).
import { type DbClient, schema } from "@wardenx/db";
import {
  type AnnouncementReader,
  type AnnouncementReceiptPerson,
  type AnnouncementService,
  type CreateDepartmentChannelInput,
  RECEIPT_LIST_LIMIT,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import { createDrizzleSiteAdminRepository } from "../../bootstrap/site-admin-repository";

const CH = schema.channels;
const CM = schema.channelMembers;
const MSG = schema.messages;
const MR = schema.messageReceipts;
const MEMBERSHIP = schema.memberships;
const USER = schema.users;
const ROLE = schema.roles;

/** The display name a staff member shows under (never blank). */
const staffName = (name: string | null): string => name?.trim() || "Staff member";

/** A Drizzle transaction handle. */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The role's name when it is enabled and visible to the organization (its own, or a platform template). */
async function disciplineName(tx: Tx, orgId: string, subjectId: string): Promise<string | null> {
  const rows = await tx
    .select({ name: ROLE.name })
    .from(ROLE)
    .where(
      and(
        eq(ROLE.id, subjectId),
        eq(ROLE.enabled, true),
        or(isNull(ROLE.organizationId), eq(ROLE.organizationId, orgId)),
      ),
    )
    .limit(1);
  return rows[0]?.name ?? null;
}

async function activeRecipients(tx: Tx, orgId: string, authorUserId: string | null) {
  return tx
    .select({ userId: USER.id, name: USER.name })
    .from(MEMBERSHIP)
    .innerJoin(USER, eq(USER.id, MEMBERSHIP.userId))
    .where(
      and(
        eq(MEMBERSHIP.organizationId, orgId),
        eq(MEMBERSHIP.status, "active"),
        eq(USER.status, "active"),
        authorUserId ? ne(USER.id, authorUserId) : undefined,
      ),
    )
    .orderBy(asc(USER.name), asc(USER.id));
}

export function createDbAnnouncementService(db: DbClient): AnnouncementService {
  // `location` is M1's table: read it through M1's site repository, never its schema (arch:tables).
  const sites = createDrizzleSiteAdminRepository(db);
  /** The location's name when it belongs to the organization, else null (one answer for foreign and unknown). */
  const locationName = async (orgId: string, subjectId: string): Promise<string | null> =>
    (await sites.getLocation(orgId, subjectId))?.name ?? null;
  return {
    async isAnnouncementChannel(orgId, userId, channelId) {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const rows = await tx
          .select({ id: CH.id })
          .from(CH)
          .where(
            and(
              eq(CH.organizationId, orgId),
              eq(CH.id, channelId),
              eq(CH.channelKind, "announcement"),
            ),
          )
          .limit(1);
        return rows.length > 0;
      });
    },

    async listAnnouncementReceipts(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const rows = await tx
          .select({
            messageId: MSG.id,
            channelId: MSG.channelId,
            authorUserId: MSG.authorUserId,
            sentAt: MSG.createdAt,
          })
          .from(MSG)
          .innerJoin(CH, and(eq(CH.id, MSG.channelId), eq(CH.organizationId, MSG.organizationId)))
          .where(
            and(
              eq(MSG.organizationId, orgId),
              eq(MSG.id, input.messageId),
              eq(CH.channelKind, "announcement"),
              isNull(MSG.deletedAt),
            ),
          )
          .limit(1);
        const message = rows[0];
        if (!message) throw new NotFoundError("announcement", input.messageId);

        const recipients = await activeRecipients(tx, orgId, message.authorUserId);
        const readAtByUser = new Map(
          (
            await tx
              .select({ userId: MR.userId, readAt: MR.readAt })
              .from(MR)
              .where(
                and(
                  eq(MR.organizationId, orgId),
                  eq(MR.messageId, message.messageId),
                  eq(MR.status, "read"),
                ),
              )
          ).flatMap((r) => (r.readAt ? [[r.userId, r.readAt.toISOString()] as const] : [])),
        );
        const readers: AnnouncementReader[] = [];
        const unread: AnnouncementReceiptPerson[] = [];
        for (const person of recipients) {
          const readAt = readAtByUser.get(person.userId);
          const displayName = staffName(person.name);
          if (readAt) readers.push({ userId: person.userId, displayName, readAt });
          else unread.push({ userId: person.userId, displayName });
        }
        return {
          messageId: message.messageId,
          channelId: message.channelId,
          sentAt: message.sentAt.toISOString(),
          recipientCount: recipients.length,
          readCount: readers.length,
          readers: readers.slice(0, RECEIPT_LIST_LIMIT),
          unread: unread.slice(0, RECEIPT_LIST_LIMIT),
          truncated: readers.length > RECEIPT_LIST_LIMIT || unread.length > RECEIPT_LIST_LIMIT,
        };
      });
    },

    async createDepartmentChannel(orgId, input) {
      const locationSubject =
        input.kind === "location" ? await locationName(orgId, input.subjectId) : null;
      return withOrgContext(
        db,
        { organizationId: orgId, userId: input.creatorUserId },
        async (tx) => {
          const subjectName =
            input.kind === "location"
              ? locationSubject
              : await disciplineName(tx, orgId, input.subjectId);
          if (!subjectName) throw new NotFoundError(`${input.kind} subject`, input.subjectId);
          const inserted = (await tx
            .insert(CH)
            .values({
              organizationId: orgId,
              channelKind: input.kind,
              subjectId: input.subjectId,
              title: input.title ?? subjectName,
              retentionClass: "care_related",
            })
            .onConflictDoNothing()
            .returning({ id: CH.id })) as Array<{ id: string }>;
          if (inserted[0]) {
            await tx.insert(CM).values({
              organizationId: orgId,
              channelId: inserted[0].id,
              userId: input.creatorUserId,
              role: "owner",
              source: "manual",
            });
            return { channelId: inserted[0].id, created: true };
          }
          const existing = (await tx
            .select({ id: CH.id })
            .from(CH)
            .where(
              and(
                eq(CH.organizationId, orgId),
                eq(CH.channelKind, input.kind),
                eq(CH.subjectId, input.subjectId),
              ),
            )
            .limit(1)) as Array<{ id: string }>;
          if (!existing[0]) throw new NotFoundError(`${input.kind} channel`, input.subjectId);
          return { channelId: existing[0].id, created: false };
        },
      );
    },
  };
}

// M36 WP 6.7 (ADR-0099, PROPOSED) - the STAFF side of family messaging in Drizzle: settings, the caregiver picker, the thread link, the invitation, the
// lane and the close / block switches. Every statement runs in one org-bound transaction; the eligibility reason is the shared SQL expression, so the lane
// and the contact's own requests judge the same facts. The services hold the rules (who may, how many); this file holds only reads and writes.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { FamilyEligibilityReason, FamilyMode, FamilySettingsDto } from "@chartwarden/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import { contactPersonJoin } from "./family-eligibility-sql";
import type {
  FamilyCaregiverRow,
  FamilyContactRow,
  FamilyStaffMessageRow,
  FamilyStaffStore,
  FamilyStaffTx,
} from "./family-store-types";

const S = schema.messageFamilySettings;
const C = schema.messageFamilyContacts;
const I = schema.messageFamilyInvitations;

/** Contacts shown in the lane at once. */
export const FAMILY_LIST_LIMIT = 500;

type Raw = Record<string, unknown>;

export const rowsOf = (res: unknown): Raw[] =>
  ((res as { rows?: unknown[] }).rows ?? (res as unknown[])) as Raw[];

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const dateOrNull = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(v as string | Date);

function toCaregiver(r: Raw): FamilyCaregiverRow {
  return {
    patientCaregiverId: str(r.patientCaregiverId),
    patientId: str(r.patientId),
    caregiverName: str(r.caregiverName),
    relationship: str(r.relationship),
    isLegalRepresentative: r.isLegalRepresentative === true,
    language: strOrNull(r.language),
    reason: str(r.reason) as FamilyEligibilityReason,
    providerEntityId: strOrNull(r.providerEntityId),
    locationId: strOrNull(r.locationId),
  };
}

function toContact(r: Raw): FamilyContactRow {
  const hasInvitation = r.invitationExpiresAt !== null && r.invitationExpiresAt !== undefined;
  return {
    contactId: str(r.contactId),
    patientId: str(r.patientId),
    patientCaregiverId: str(r.patientCaregiverId),
    patientName: str(r.patientName),
    caregiverName: str(r.caregiverName),
    relationship: str(r.relationship),
    reason: str(r.reason) as FamilyEligibilityReason,
    mode: str(r.mode) as FamilyMode,
    language: strOrNull(r.language),
    closed: r.closed === true,
    blocked: r.blocked === true,
    blockedBy: strOrNull(r.blockedBy),
    channelId: strOrNull(r.channelId),
    lastContactMessageAt: dateOrNull(r.lastContactMessageAt),
    lastStaffReplyAt: dateOrNull(r.lastStaffReplyAt),
    staffSeenThrough: dateOrNull(r.staffSeenThrough),
    invitation: hasInvitation
      ? {
          expiresAt: new Date(r.invitationExpiresAt as string | Date),
          redeemed: r.invitationRedeemed === true,
          codeAttempts: Number(r.codeAttempts ?? 0),
          activeSession: r.activeSession === true,
          verifyingSession: r.verifyingSession === true,
        }
      : null,
    sentLastHour: Number(r.sentLastHour ?? 0),
    unansweredSince: dateOrNull(r.unansweredSince),
    hadRevokedInvitation: r.hadRevokedInvitation === true,
    dbNow: new Date(r.dbNow as string | Date),
  };
}

const CAREGIVER_SELECT = sql`
  SELECT fp.patient_caregiver_id AS "patientCaregiverId", fp.patient_id AS "patientId", fp.caregiver_name AS "caregiverName",
         fp.relationship AS "relationship", fp.is_legal_representative AS "isLegalRepresentative", fp.language AS "language",
         fp.reason AS "reason", fp.provider_entity_id AS "providerEntityId", fp.location_id AS "locationId"`;

const CONTACT_SELECT = sql`
  SELECT c.id AS "contactId", c.patient_id AS "patientId", c.patient_caregiver_id AS "patientCaregiverId",
         fp.patient_name AS "patientName", fp.caregiver_name AS "caregiverName", fp.relationship AS "relationship",
         fp.reason AS "reason", c.mode AS "mode", fp.language AS "language",
         (c.closed_at IS NOT NULL) AS "closed", (c.blocked_at IS NOT NULL) AS "blocked", c.blocked_by AS "blockedBy",
         c.channel_id AS "channelId", c.last_contact_message_at AS "lastContactMessageAt",
         c.last_staff_reply_at AS "lastStaffReplyAt", c.staff_seen_through AS "staffSeenThrough",
         i.expires_at AS "invitationExpiresAt", (i.invite_redeemed_at IS NOT NULL) AS "invitationRedeemed", i.code_attempts AS "codeAttempts",
         EXISTS (SELECT 1 FROM message_family_session x WHERE x.organization_id = i.organization_id AND x.invitation_id = i.id
                  AND x.stage = 'active' AND x.expires_at > now() AND x.last_seen_at > now() - interval '30 minutes') AS "activeSession",
         EXISTS (SELECT 1 FROM message_family_session x WHERE x.organization_id = i.organization_id AND x.invitation_id = i.id
                  AND x.stage = 'enrolment' AND x.expires_at > now() AND x.last_seen_at > now() - interval '30 minutes') AS "verifyingSession",
         (SELECT count(*) FROM message m WHERE m.organization_id = c.organization_id AND m.channel_id = c.channel_id
             AND m.author_kind::text = 'family_contact' AND m.created_at > now() - interval '1 hour')::int AS "sentLastHour",
         (SELECT min(m.created_at) FROM message m WHERE m.organization_id = c.organization_id AND m.channel_id = c.channel_id
             AND m.author_kind::text = 'family_contact'
             AND m.created_at > COALESCE(c.last_staff_reply_at, '-infinity'::timestamptz)) AS "unansweredSince",
         EXISTS (SELECT 1 FROM message_family_invitation r WHERE r.organization_id = c.organization_id AND r.contact_id = c.id
                  AND r.revoked_at IS NOT NULL) AS "hadRevokedInvitation",
         now() AS "dbNow"
    FROM message_family_contact c
    ${contactPersonJoin}
    LEFT JOIN message_family_invitation i ON i.organization_id = c.organization_id AND i.contact_id = c.id AND i.revoked_at IS NULL`;

export function createDrizzleFamilyStaffStore(db: DbClient): FamilyStaffStore {
  return {
    run: (actor, fn) =>
      withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          const orgId = actor.organizationId;
          const contactById = async (id: string): Promise<FamilyContactRow | null> => {
            const res = await tx.execute(
              sql`${CONTACT_SELECT} WHERE c.id = ${id} AND c.organization_id = ${orgId} LIMIT 1`,
            );
            const row = rowsOf(res)[0];
            return row ? toContact(row) : null;
          };
          const impl: FamilyStaffTx = {
            raw: tx,
            async lockTenant() {
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtextextended(${`message-family:${orgId}`}, 67))`,
              );
            },
            async getSettings() {
              const [row] = await tx.select().from(S).where(eq(S.organizationId, orgId)).limit(1);
              return {
                agencyName: row?.agencyName ?? null,
                agencyPhone: row?.agencyPhone ?? null,
                bereavementPhone: row?.bereavementPhone ?? null,
              };
            },
            async putSettings(userId, settings: FamilySettingsDto) {
              const existing = await tx
                .select({ id: S.organizationId })
                .from(S)
                .where(eq(S.organizationId, orgId))
                .limit(1);
              const values = {
                agencyName: settings.agencyName,
                agencyPhone: settings.agencyPhone,
                bereavementPhone: settings.bereavementPhone,
                updatedBy: userId,
              };
              if (existing.length > 0) {
                await tx.update(S).set(values).where(eq(S.organizationId, orgId));
              } else {
                await tx.insert(S).values({ organizationId: orgId, ...values });
              }
              return settings;
            },
            async caregivers(patientId) {
              const res = await tx.execute(
                sql`${CAREGIVER_SELECT}
                    FROM message_family_caregivers(${patientId}) ids
                    CROSS JOIN LATERAL message_family_person(ids.patient_caregiver_id) fp
                    ORDER BY ids.ord`,
              );
              return rowsOf(res).map(toCaregiver);
            },
            async caregiver(patientCaregiverId) {
              const res = await tx.execute(
                sql`${CAREGIVER_SELECT} FROM message_family_person(${patientCaregiverId}) fp LIMIT 1`,
              );
              const row = rowsOf(res)[0];
              return row ? toCaregiver(row) : null;
            },
            async ensureContact(userId, caregiver) {
              const [existing] = await tx
                .select({ id: C.id })
                .from(C)
                .where(
                  and(
                    eq(C.organizationId, orgId),
                    eq(C.patientCaregiverId, caregiver.patientCaregiverId),
                  ),
                )
                .limit(1);
              if (existing) return existing.id;
              const [inserted] = await tx
                .insert(C)
                .values({
                  organizationId: orgId,
                  providerEntityId: caregiver.providerEntityId,
                  locationId: caregiver.locationId,
                  patientId: caregiver.patientId,
                  patientCaregiverId: caregiver.patientCaregiverId,
                  createdBy: userId,
                })
                .returning({ id: C.id });
              if (!inserted) throw new Error("family contact insert returned no row");
              return inserted.id;
            },
            async counts(creatorUserId) {
              const [row] = await tx
                .select({
                  orgDay: sql<number>`count(*) FILTER (WHERE ${I.createdAt} > now() - interval '1 day')::int`,
                  creatorDay: sql<number>`count(*) FILTER (WHERE ${I.createdBy} = ${creatorUserId} AND ${I.createdAt} > now() - interval '1 day')::int`,
                })
                .from(I)
                .where(eq(I.organizationId, orgId));
              return { orgDay: Number(row?.orgDay ?? 0), creatorDay: Number(row?.creatorDay ?? 0) };
            },
            async revokeLive(contactId, userId, reason) {
              const done = await tx
                .update(I)
                .set({ revokedAt: sql`now()`, revokedBy: userId, revokeReason: reason })
                .where(
                  and(eq(I.organizationId, orgId), eq(I.contactId, contactId), isNull(I.revokedAt)),
                )
                .returning({ id: I.id });
              return done.length > 0;
            },
            async insertInvitation(userId, input) {
              const [inserted] = await tx
                .insert(I)
                .values({
                  organizationId: orgId,
                  contactId: input.contactId,
                  createdBy: userId,
                  inviteTokenHash: input.inviteTokenHash,
                  codeHash: input.codeHash,
                  expiresAt: sql`now() + make_interval(days => ${input.expiresInDays})`,
                })
                .returning({ expiresAt: I.expiresAt });
              if (!inserted) throw new Error("family invitation insert returned no row");
              return inserted;
            },
            getContact: contactById,
            async listContacts() {
              const res = await tx.execute(
                sql`${CONTACT_SELECT} WHERE c.organization_id = ${orgId}
                    ORDER BY c.last_contact_message_at DESC NULLS LAST, c.created_at DESC LIMIT ${FAMILY_LIST_LIMIT}`,
              );
              return rowsOf(res).map(toContact);
            },
            async setClosed(contactId, userId, closed) {
              const done = await tx
                .update(C)
                .set(
                  closed
                    ? { closedAt: sql`now()`, closedBy: userId }
                    : { closedAt: null, closedBy: null },
                )
                .where(
                  and(
                    eq(C.organizationId, orgId),
                    eq(C.id, contactId),
                    closed ? isNull(C.closedAt) : sql`${C.closedAt} IS NOT NULL`,
                  ),
                )
                .returning({ id: C.id });
              return done.length > 0;
            },
            async setBlocked(contactId, userId, blocked) {
              const done = await tx
                .update(C)
                .set(
                  blocked
                    ? { blockedAt: sql`now()`, blockedBy: userId }
                    : { blockedAt: null, blockedBy: null },
                )
                .where(
                  and(
                    eq(C.organizationId, orgId),
                    eq(C.id, contactId),
                    blocked ? isNull(C.blockedAt) : sql`${C.blockedAt} IS NOT NULL`,
                  ),
                )
                .returning({ id: C.id });
              return done.length > 0;
            },
            async messages(channelId, limit) {
              const res = await tx.execute(sql`
                SELECT * FROM (
                  SELECT m.id AS "id", m.author_kind::text AS "authorKind", u.name AS "authorName", m.body_cipher AS "bodyCipher",
                         m.body_kind::text AS "bodyKind", m.status::text AS "status", m.created_at AS "createdAt",
                         EXISTS (SELECT 1 FROM message_redaction d WHERE d.organization_id = m.organization_id AND d.message_id = m.id
                                  AND d.approved_at IS NOT NULL) AS "redacted"
                    FROM message m LEFT JOIN "user" u ON u.id = m.author_user_id
                   WHERE m.organization_id = ${orgId} AND m.channel_id = ${channelId} AND m.status::text <> 'deleted'
                   ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}) page
                ORDER BY "createdAt" ASC, "id" ASC`);
              return rowsOf(res).map(
                (r): FamilyStaffMessageRow => ({
                  id: str(r.id),
                  authorKind: str(r.authorKind),
                  authorName: strOrNull(r.authorName),
                  bodyCipher: Buffer.isBuffer(r.bodyCipher)
                    ? r.bodyCipher
                    : Buffer.from(str(r.bodyCipher).replace(/^\\x/, ""), "hex"),
                  bodyKind: str(r.bodyKind),
                  status: str(r.status),
                  createdAt: new Date(r.createdAt as string | Date),
                  redacted: r.redacted === true,
                }),
              );
            },
            async markSeen(contactId, through) {
              await tx
                .update(C)
                .set({
                  staffSeenThrough: sql`GREATEST(coalesce(${C.staffSeenThrough}, '-infinity'::timestamptz), ${through.toISOString()}::timestamptz)`,
                })
                .where(and(eq(C.organizationId, orgId), eq(C.id, contactId)));
            },
            async markReplied(contactId) {
              await tx
                .update(C)
                .set({
                  lastStaffReplyAt: sql`GREATEST(coalesce(${C.lastStaffReplyAt}, '-infinity'::timestamptz), now())`,
                })
                .where(and(eq(C.organizationId, orgId), eq(C.id, contactId)));
            },
          };
          return fn(impl);
        },
      ),
  };
}

// M36 WP 6.7 (ADR-0099, PROPOSED) - the CONTACT side of family messaging in Drizzle. A contact request runs under the organisation only (no user): its
// tenancy is the org id carried by the bearer plus FORCEd RLS. EVERY liveness and eligibility judgement is made by the DATABASE clock in the same
// statement as the read it protects (D12): the bearer, its invitation, the thread link, the person, the patient, the consent and the Part 2 flag resolve
// together or not at all. The thread is whatever the invitation row says: no id from the request ever selects a conversation.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  FAMILY_MAX_CODE_ATTEMPTS,
  FAMILY_SESSION_IDLE_MINUTES,
  FAMILY_SESSION_MAX_HOURS,
  type FamilyMode,
  type FamilySessionStage,
} from "@chartwarden/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import { contactPersonJoin } from "./family-eligibility-sql";
import { rowsOf } from "./family-store-staff";
import type {
  FamilyContactRawMessage,
  FamilyContactStore,
  FamilyContactTx,
  FamilyLiveSession,
} from "./family-store-types";

const S = schema.messageFamilySettings;
const C = schema.messageFamilyContacts;
const I = schema.messageFamilyInvitations;
const X = schema.messageFamilySessions;
const A = schema.messageFamilyAccess;
const CH = schema.channels;

/** The title of the staff-side conversation: neutral, no person in it (the lane resolves names at read time). */
const FAMILY_CHANNEL_TITLE = "Family messages";

export function createDrizzleFamilyContactStore(db: DbClient): FamilyContactStore {
  return {
    run: (organizationId, fn) =>
      withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
        const impl: FamilyContactTx = {
          raw: tx,
          async redeemInvite(tokenHash) {
            const rows = await tx
              .update(I)
              .set({ inviteRedeemedAt: sql`now()` })
              .where(
                and(
                  eq(I.organizationId, organizationId),
                  eq(I.inviteTokenHash, tokenHash),
                  isNull(I.inviteRedeemedAt),
                  isNull(I.revokedAt),
                  sql`${I.expiresAt} > now()`,
                ),
              )
              .returning({ invitationId: I.id, expiresAt: I.expiresAt });
            return rows[0] ?? null;
          },
          async insertSession(invitationId, tokenHash) {
            const [inserted] = await tx
              .insert(X)
              .values({
                organizationId,
                invitationId,
                tokenHash,
                // Never past the invitation, never past the absolute session lifetime.
                expiresAt: sql`LEAST((SELECT i.expires_at FROM message_family_invitation i WHERE i.organization_id = ${organizationId} AND i.id = ${invitationId}), now() + make_interval(hours => ${FAMILY_SESSION_MAX_HOURS}))`,
              })
              .returning({ sessionId: X.id });
            if (!inserted) throw new Error("family session insert returned no row");
            return inserted;
          },
          async resolveSession(tokenHash) {
            // One statement: the CTE judges session + invitation + contact + the whole eligibility on the database clock; the UPDATE touches the
            // session only when the verdict is `ok`. Zero rows is every refusal there is (no reason leaves the database).
            const res = await tx.execute(sql`
              WITH live AS (
                SELECT x.id AS session_id, i.id AS invitation_id, c.id AS contact_id, c.patient_id AS patient_id, x.stage AS stage,
                       x.expires_at AS session_expires_at, fp.mode AS mode, c.mode AS stored_mode,
                       (c.closed_at IS NOT NULL) AS closed, c.channel_id AS channel_id, fp.language AS language,
                       c.staff_seen_through AS staff_seen_through, fp.reason AS reason
                  FROM message_family_session x
                  JOIN message_family_invitation i ON i.organization_id = x.organization_id AND i.id = x.invitation_id
                  JOIN message_family_contact c ON c.organization_id = i.organization_id AND c.id = i.contact_id
                  ${contactPersonJoin}
                 WHERE x.organization_id = ${organizationId} AND x.token_hash = ${tokenHash}
                   AND fp.patient_id = c.patient_id AND x.expires_at > now()
                   AND x.last_seen_at > now() - make_interval(mins => ${FAMILY_SESSION_IDLE_MINUTES})
                   AND i.revoked_at IS NULL AND i.expires_at > now())
              UPDATE message_family_session x SET last_seen_at = now()
                FROM live
               WHERE x.organization_id = ${organizationId} AND x.id = live.session_id AND live.reason = 'ok'
              RETURNING x.id AS "sessionId", live.invitation_id AS "invitationId", live.contact_id AS "contactId", live.patient_id AS "patientId",
                        x.stage AS "stage", live.session_expires_at AS "sessionExpiresAt", live.mode AS "mode", live.stored_mode AS "storedMode",
                        live.closed AS "closed", live.channel_id AS "channelId", live.language AS "language",
                        live.staff_seen_through AS "staffSeenThrough"`);
            const r = rowsOf(res)[0];
            if (!r) return null;
            const live: FamilyLiveSession = {
              organizationId,
              sessionId: String(r.sessionId),
              invitationId: String(r.invitationId),
              contactId: String(r.contactId),
              patientId: String(r.patientId),
              stage: String(r.stage) as FamilySessionStage,
              sessionExpiresAt: new Date(r.sessionExpiresAt as string | Date),
              mode: String(r.mode) as FamilyMode,
              storedMode: String(r.storedMode) as FamilyMode,
              closed: r.closed === true,
              channelId: r.channelId ? String(r.channelId) : null,
              language: r.language ? String(r.language) : null,
              staffSeenThrough: r.staffSeenThrough
                ? new Date(r.staffSeenThrough as string | Date)
                : null,
            };
            return live;
          },
          async takeCodeAttempt(invitationId) {
            const rows = await tx
              .update(I)
              .set({ codeAttempts: sql`${I.codeAttempts} + 1` })
              .where(
                and(
                  eq(I.organizationId, organizationId),
                  eq(I.id, invitationId),
                  sql`${I.codeAttempts} < ${FAMILY_MAX_CODE_ATTEMPTS}`,
                  isNull(I.revokedAt),
                  sql`${I.expiresAt} > now()`,
                ),
              )
              .returning({ codeHash: I.codeHash });
            return rows[0]?.codeHash ?? null;
          },
          async activate(sessionId, newTokenHash) {
            await tx
              .update(X)
              .set({ stage: "active", activatedAt: sql`now()`, tokenHash: newTokenHash })
              .where(
                and(
                  eq(X.organizationId, organizationId),
                  eq(X.id, sessionId),
                  eq(X.stage, "enrolment"),
                ),
              );
          },
          async getSettings() {
            const [row] = await tx
              .select()
              .from(S)
              .where(eq(S.organizationId, organizationId))
              .limit(1);
            return {
              agencyName: row?.agencyName ?? null,
              agencyPhone: row?.agencyPhone ?? null,
              bereavementPhone: row?.bereavementPhone ?? null,
            };
          },
          async switchToBereavement(contactId) {
            await tx
              .update(C)
              .set({ mode: "bereavement" })
              .where(
                and(
                  eq(C.organizationId, organizationId),
                  eq(C.id, contactId),
                  eq(C.mode, "standard"),
                ),
              );
          },
          async visibleMessages(live, after, limit) {
            if (!live.channelId) return [];
            const cursor = after
              ? sql`AND (m.created_at, m.id) > (${after.createdAtText}::timestamptz, ${after.id}::uuid)`
              : sql``;
            // The channel comes from the invitation row (live.channelId), is of kind `family`, and only text a person wrote is shown: no system line,
            // no urgent line, no deleted tombstone, and nothing an approved redaction masks (ADR-0055).
            const res = await tx.execute(sql`
              SELECT m.id AS "id", m.author_kind::text AS "authorKind", m.body_cipher AS "bodyCipher", m.body_kind::text AS "bodyKind",
                     m.created_at::text AS "createdAtText"
                FROM message m
                JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id
               WHERE m.organization_id = ${organizationId} AND m.channel_id = ${live.channelId} AND c.channel_kind::text = 'family'
                 AND m.status::text <> 'deleted' AND m.author_kind::text IN ('user', 'family_contact')
                 AND m.body_kind::text <> 'system' AND m.urgency::text = 'routine'
                 AND NOT EXISTS (SELECT 1 FROM message_redaction d WHERE d.organization_id = m.organization_id AND d.message_id = m.id AND d.approved_at IS NOT NULL)
                 ${cursor}
               ORDER BY m.created_at ASC, m.id ASC
               LIMIT ${limit}`);
            return rowsOf(res).map(
              (r): FamilyContactRawMessage => ({
                id: String(r.id),
                authorKind: String(r.authorKind),
                bodyCipher: Buffer.isBuffer(r.bodyCipher)
                  ? r.bodyCipher
                  : Buffer.from(String(r.bodyCipher).replace(/^\\x/, ""), "hex"),
                bodyKind: String(r.bodyKind),
                createdAtText: String(r.createdAtText),
              }),
            );
          },
          async sendBudget(live) {
            if (!live.channelId) return { lastHour: 0, lastDay: 0, sinceStaffReply: 0 };
            const res = await tx.execute(sql`
              SELECT count(*) FILTER (WHERE m.created_at > now() - interval '1 hour')::int AS "lastHour",
                     count(*) FILTER (WHERE m.created_at > now() - interval '1 day')::int AS "lastDay",
                     count(*) FILTER (WHERE m.created_at > COALESCE(
                       (SELECT c.last_staff_reply_at FROM message_family_contact c WHERE c.organization_id = ${organizationId} AND c.id = ${live.contactId}),
                       '-infinity'::timestamptz))::int AS "sinceStaffReply"
                FROM message m
               WHERE m.organization_id = ${organizationId} AND m.channel_id = ${live.channelId} AND m.author_kind::text = 'family_contact'`);
            const r = rowsOf(res)[0] ?? {};
            return {
              lastHour: Number(r.lastHour ?? 0),
              lastDay: Number(r.lastDay ?? 0),
              sinceStaffReply: Number(r.sinceStaffReply ?? 0),
            };
          },
          async ensureChannel(live) {
            // Row-lock the thread link: two first sends serialise here and exactly one creates the conversation.
            const [row] = await tx
              .select({ channelId: C.channelId })
              .from(C)
              .where(and(eq(C.organizationId, organizationId), eq(C.id, live.contactId)))
              .for("update")
              .limit(1);
            if (!row) throw new Error("family thread link vanished");
            if (row.channelId) return row.channelId;
            const [channel] = await tx
              .insert(CH)
              .values({
                organizationId,
                channelKind: "family",
                subjectId: live.patientId,
                title: FAMILY_CHANNEL_TITLE,
                retentionClass: "care_related",
              })
              .returning({ id: CH.id });
            if (!channel) throw new Error("family channel insert returned no row");
            await tx
              .update(C)
              .set({ channelId: channel.id })
              .where(and(eq(C.organizationId, organizationId), eq(C.id, live.contactId)));
            return channel.id;
          },
          async touchContactMessage(contactId) {
            await tx
              .update(C)
              .set({ lastContactMessageAt: sql`now()` })
              .where(and(eq(C.organizationId, organizationId), eq(C.id, contactId)));
          },
          async recordAccess(live, action, messageCount, messageId) {
            await tx.insert(A).values({
              organizationId,
              contactId: live.contactId,
              sessionId: live.sessionId,
              action,
              messageCount,
              messageId,
            });
          },
        };
        return fn(impl);
      }),
  };
}

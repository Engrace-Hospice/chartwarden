// M36 WP 6.6 (ADR-0096, PROPOSED) - the storage ports of the external partner share and their Drizzle implementation. The services hold every rule;
// this is only reads and writes inside ONE tenant transaction, so the unit matrix runs against a fake and the live suite proves the SQL.
// EVERY liveness judgement (revoked, expired, stage) is made by the DATABASE clock in the same statement as the read it protects: nothing is
// cached, so a revoke is the partner's very next 404 (ADR-0096 D4).
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  EXTERNAL_SESSION_IDLE_MINUTES,
  EXTERNAL_SESSION_MAX_HOURS,
  EXTERNAL_SHARE_CHANNEL_KINDS,
  EXTERNAL_SHARE_MAX_CODE_ATTEMPTS,
  type ExternalSessionStage,
  type ExternalSharePartnerKind,
  type ExternalShareStatus,
} from "@chartwarden/types";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { activeLiveHolds, anyHoldPredicate } from "../jobs/retention-hold-sql";
import type { Tx } from "../messaging-write-core";

const S = schema.messageExternalShares;
const X = schema.messageExternalSessions;
const R = schema.messageExternalShareReads;
const CH = schema.channels;

/** Shares listed at once. */
export const EXTERNAL_SHARE_LIST_LIMIT = 100;

export interface ShareRow {
  readonly id: string;
  readonly channelId: string;
  readonly channelTitle: string | null;
  readonly partnerName: string;
  readonly partnerKind: ExternalSharePartnerKind;
  readonly sharedFrom: Date;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly revokedAt: Date | null;
  readonly redeemed: boolean;
  readonly codeAttempts: number;
  /** The database's `now()` when the row was read: the status judgement uses this, never the app clock. */
  readonly dbNow: Date;
}

export function shareStatus(
  row: Pick<ShareRow, "revokedAt" | "expiresAt" | "dbNow">,
): ExternalShareStatus {
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() > row.dbNow.getTime() ? "active" : "expired";
}

export interface NewShare {
  readonly channelId: string;
  readonly partnerName: string;
  readonly partnerKind: ExternalSharePartnerKind;
  readonly baaReference: string;
  readonly expiresInDays: number;
  readonly inviteTokenHash: string;
  readonly codeHash: string;
  /** D15: the creator's confirmation, stored on the share and CHECKed true. */
  readonly minimumNecessaryAcknowledged: true;
}

export interface StaffTx {
  /** The raw transaction handle the outbox publishes on. */
  readonly raw: unknown;
  /** The kind of a channel in this tenant, or null when there is none (RLS scopes the read). */
  channelKind(channelId: string): Promise<string | null>;
  /** Serialise share creation per tenant so two concurrent creates cannot both pass the caps. */
  lockTenant(): Promise<void>;
  counts(creatorUserId: string): Promise<{ readonly live: number; readonly creatorDay: number }>;
  insertShare(creatorUserId: string, input: NewShare): Promise<ShareRow>;
  getShare(id: string): Promise<ShareRow | null>;
  /** Null when the share is already revoked. */
  revoke(id: string, userId: string): Promise<ShareRow | null>;
  listShares(): Promise<ShareRow[]>;
  /**
   * D14: replace the invitation and the code of a LIVE share, start the counter from zero and bump the generation, which kills every older session.
   * Null when the share is revoked or expired. The guard trigger makes this the only path that resets the counter.
   */
  reissue(
    id: string,
    userId: string,
    inviteTokenHash: string,
    codeHash: string,
  ): Promise<ShareRow | null>;
  /** D18: the live (unrevoked, unexpired, database clock) share on a channel that expires last, or null. Read live every time. */
  activeIndicator(
    channelId: string,
  ): Promise<{ readonly partnerKind: ExternalSharePartnerKind; readonly expiresAt: Date } | null>;
}

export interface StaffActor {
  readonly organizationId: string;
  readonly userId: string;
}

export interface ShareStaffStore {
  run<T>(actor: StaffActor, fn: (tx: StaffTx) => Promise<T>): Promise<T>;
}

/** What one request's bearer resolves to, in ONE statement; absent means "no live, matching session" and nothing more. */
export interface LiveSession {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly shareId: string;
  readonly stage: ExternalSessionStage;
  readonly channelId: string;
  readonly channelKind: string;
  readonly partnerName: string;
  readonly shareExpiresAt: Date;
  readonly sharedFrom: Date;
}

export interface PartnerRawMessage {
  readonly id: string;
  readonly authorName: string | null;
  readonly bodyCipher: Buffer;
  readonly bodyKind: string;
  readonly status: string;
  readonly createdAtText: string;
}

export interface PartnerTx {
  readonly raw: unknown;
  /** Single use: redeems the invitation by hash if it is unredeemed, unrevoked and unexpired NOW. Null otherwise. */
  redeemInvite(
    tokenHash: string,
  ): Promise<{ readonly shareId: string; readonly expiresAt: Date } | null>;
  /** Born against the redeemed share and bounded by its expiry (the guard also checks). */
  insertSession(shareId: string, tokenHash: string): Promise<{ readonly sessionId: string }>;
  /**
   * D4/D13: ONE statement that decides liveness AND records the request: the share is unrevoked and unexpired, the session is of the share's
   * current invitation generation, under its absolute lifetime and idle for under 30 minutes, all on the database clock; a hit touches last_seen_at.
   */
  resolveSession(tokenHash: string): Promise<LiveSession | null>;
  /** Counts the attempt FIRST (atomically, capped at 5) and returns the stored code hash; null when the share is locked or gone. */
  takeCodeAttempt(shareId: string): Promise<string | null>;
  /** enrolment -> active AND the bearer hash is replaced in one update (D13): the enrolment token is dead from this commit on. */
  activate(sessionId: string, newTokenHash: string): Promise<void>;
  /** Visible messages (ADR-0096 D2) after the cursor, at most `limit`, oldest first. */
  visibleMessages(
    live: LiveSession,
    after: { readonly createdAtText: string; readonly id: string } | null,
    limit: number,
  ): Promise<PartnerRawMessage[]>;
  /** The audit trail row; the database guard refuses it unless the session is active and the share live NOW. */
  recordRead(live: LiveSession, messageCount: number, withheldCount: number): Promise<void>;
}

export interface SharePartnerStore {
  run<T>(organizationId: string, fn: (tx: PartnerTx) => Promise<T>): Promise<T>;
}

const dbNow = sql<Date>`now()`.mapWith((value: unknown) => new Date(String(value)));

const SHARE_COLUMNS = {
  id: S.id,
  channelId: S.channelId,
  channelTitle: CH.title,
  partnerName: S.partnerName,
  partnerKind: S.partnerKind,
  sharedFrom: S.sharedFrom,
  expiresAt: S.expiresAt,
  createdAt: S.createdAt,
  createdBy: S.createdBy,
  revokedAt: S.revokedAt,
  redeemed: sql<boolean>`${S.inviteRedeemedAt} IS NOT NULL`,
  codeAttempts: S.codeAttempts,
  dbNow,
} as const;

type RawShare = Omit<ShareRow, "partnerKind"> & { partnerKind: string };
const toShare = (r: RawShare): ShareRow => ({
  ...r,
  partnerKind: r.partnerKind as ExternalSharePartnerKind,
});

const selectShares = (tx: Tx) =>
  tx
    .select(SHARE_COLUMNS)
    .from(S)
    .leftJoin(CH, and(eq(CH.organizationId, S.organizationId), eq(CH.id, S.channelId)));

const KIND_LIST = sql.join(
  EXTERNAL_SHARE_CHANNEL_KINDS.map((k) => sql`${k}`),
  sql`, `,
);

export function createDrizzleShareStaffStore(db: DbClient): ShareStaffStore {
  return {
    run: (actor, fn) =>
      withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          const orgId = actor.organizationId;
          const byId = async (id: string): Promise<ShareRow | null> => {
            const [row] = await selectShares(tx)
              .where(and(eq(S.organizationId, orgId), eq(S.id, id)))
              .limit(1);
            return row ? toShare(row) : null;
          };
          return fn({
            raw: tx,
            async channelKind(channelId) {
              const [row] = await tx
                .select({ kind: CH.channelKind })
                .from(CH)
                .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
                .limit(1);
              return row?.kind ?? null;
            },
            async lockTenant() {
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtextextended(${`message-external-share:${orgId}`}, 61))`,
              );
            },
            async counts(creatorUserId) {
              const [row] = await tx
                .select({
                  live: sql<number>`count(*) FILTER (WHERE ${S.revokedAt} IS NULL AND ${S.expiresAt} > now())::int`,
                  creatorDay: sql<number>`count(*) FILTER (WHERE ${S.createdBy} = ${creatorUserId} AND ${S.createdAt} > now() - interval '1 day')::int`,
                })
                .from(S)
                .where(eq(S.organizationId, orgId));
              return { live: Number(row?.live ?? 0), creatorDay: Number(row?.creatorDay ?? 0) };
            },
            async insertShare(creatorUserId, input) {
              const [inserted] = await tx
                .insert(S)
                .values({
                  organizationId: orgId,
                  channelId: input.channelId,
                  createdBy: creatorUserId,
                  partnerName: input.partnerName,
                  partnerKind: input.partnerKind,
                  baaReference: input.baaReference,
                  expiresAt: sql`now() + make_interval(days => ${input.expiresInDays})`,
                  inviteTokenHash: input.inviteTokenHash,
                  codeHash: input.codeHash,
                  minimumNecessaryAcknowledged: input.minimumNecessaryAcknowledged,
                })
                .returning({ id: S.id });
              if (!inserted) throw new Error("external share insert returned no row");
              const row = await byId(inserted.id);
              if (!row) throw new Error("external share not readable after insert");
              return row;
            },
            getShare: byId,
            async revoke(id, userId) {
              const done = await tx
                .update(S)
                .set({ revokedAt: sql`now()`, revokedBy: userId })
                .where(and(eq(S.organizationId, orgId), eq(S.id, id), isNull(S.revokedAt)))
                .returning({ id: S.id });
              return done.length > 0 ? byId(id) : null;
            },
            async reissue(id, userId, inviteTokenHash, codeHash) {
              const done = await tx
                .update(S)
                .set({
                  inviteTokenHash,
                  codeHash,
                  inviteGeneration: sql`${S.inviteGeneration} + 1`,
                  inviteRedeemedAt: null,
                  codeAttempts: 0,
                  reissuedBy: userId,
                })
                .where(
                  and(
                    eq(S.organizationId, orgId),
                    eq(S.id, id),
                    isNull(S.revokedAt),
                    sql`${S.expiresAt} > now()`,
                  ),
                )
                .returning({ id: S.id });
              return done.length > 0 ? byId(id) : null;
            },
            async activeIndicator(channelId) {
              const [row] = await tx
                .select({ partnerKind: S.partnerKind, expiresAt: S.expiresAt })
                .from(S)
                .where(
                  and(
                    eq(S.organizationId, orgId),
                    eq(S.channelId, channelId),
                    isNull(S.revokedAt),
                    sql`${S.expiresAt} > now()`,
                  ),
                )
                .orderBy(desc(S.expiresAt))
                .limit(1);
              return row
                ? {
                    partnerKind: row.partnerKind as ExternalSharePartnerKind,
                    expiresAt: row.expiresAt,
                  }
                : null;
            },
            async listShares() {
              const rows = await selectShares(tx)
                .where(eq(S.organizationId, orgId))
                .orderBy(desc(S.createdAt), desc(S.id))
                .limit(EXTERNAL_SHARE_LIST_LIMIT);
              return rows.map(toShare);
            },
          });
        },
      ),
  };
}

export function createDrizzleSharePartnerStore(db: DbClient): SharePartnerStore {
  return {
    run: (organizationId, fn) =>
      withOrgContext(db, systemOrgContext(organizationId), async (tx) =>
        fn({
          raw: tx,
          async redeemInvite(tokenHash) {
            const rows = await tx
              .update(S)
              .set({ inviteRedeemedAt: sql`now()` })
              .where(
                and(
                  eq(S.organizationId, organizationId),
                  eq(S.inviteTokenHash, tokenHash),
                  isNull(S.inviteRedeemedAt),
                  isNull(S.revokedAt),
                  sql`${S.expiresAt} > now()`,
                ),
              )
              .returning({ shareId: S.id, expiresAt: S.expiresAt });
            const row = rows[0];
            return row ?? null;
          },
          async insertSession(shareId, tokenHash) {
            const [inserted] = await tx
              .insert(X)
              .values({
                organizationId,
                shareId,
                tokenHash,
                // Never past the share, never past the absolute session lifetime.
                expiresAt: sql`LEAST((SELECT s.expires_at FROM message_external_share s WHERE s.organization_id = ${organizationId} AND s.id = ${shareId}), now() + make_interval(hours => ${EXTERNAL_SESSION_MAX_HOURS}))`,
                inviteGeneration: sql`(SELECT s.invite_generation FROM message_external_share s WHERE s.organization_id = ${organizationId} AND s.id = ${shareId})`,
              })
              .returning({ sessionId: X.id });
            if (!inserted) throw new Error("external session insert returned no row");
            return inserted;
          },
          async resolveSession(tokenHash) {
            const res = await tx.execute(sql`
              UPDATE message_external_session x SET last_seen_at = now()
                FROM message_external_share s, channel c
               WHERE x.organization_id = ${organizationId} AND x.token_hash = ${tokenHash}
                 AND s.organization_id = x.organization_id AND s.id = x.share_id
                 AND c.organization_id = s.organization_id AND c.id = s.channel_id
                 AND x.expires_at > now()
                 AND x.last_seen_at > now() - make_interval(mins => ${EXTERNAL_SESSION_IDLE_MINUTES})
                 AND x.invite_generation = s.invite_generation
                 AND s.revoked_at IS NULL AND s.expires_at > now()
              RETURNING x.id AS "sessionId", s.id AS "shareId", x.stage AS "stage", s.channel_id AS "channelId",
                        c.channel_kind::text AS "channelKind", s.partner_name AS "partnerName",
                        s.expires_at AS "shareExpiresAt", s.shared_from AS "sharedFrom"`);
            const rows =
              (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[]);
            const r = (rows as Array<Record<string, unknown>>)[0];
            if (!r) return null;
            return {
              organizationId,
              sessionId: String(r.sessionId),
              shareId: String(r.shareId),
              stage: String(r.stage) as ExternalSessionStage,
              channelId: String(r.channelId),
              channelKind: String(r.channelKind),
              partnerName: String(r.partnerName),
              shareExpiresAt: new Date(r.shareExpiresAt as string | Date),
              sharedFrom: new Date(r.sharedFrom as string | Date),
            };
          },
          async takeCodeAttempt(shareId) {
            const rows = await tx
              .update(S)
              .set({ codeAttempts: sql`${S.codeAttempts} + 1` })
              .where(
                and(
                  eq(S.organizationId, organizationId),
                  eq(S.id, shareId),
                  sql`${S.codeAttempts} < ${EXTERNAL_SHARE_MAX_CODE_ATTEMPTS}`,
                  isNull(S.revokedAt),
                  sql`${S.expiresAt} > now()`,
                ),
              )
              .returning({ codeHash: S.codeHash });
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
          async visibleMessages(live, after, limit) {
            const cursor = after
              ? sql`AND (b.created_at, b.id) > (${after.createdAtText}::timestamptz, ${after.id}::uuid)`
              : sql``;
            // ADR-0096 D2/D8: a legal hold hides what it covers (live criteria, like the export), judged in the same statement.
            const holds = await activeLiveHolds(tx as unknown as DbClient, organizationId);
            const held = anyHoldPredicate(holds);
            // `base` is every message a partner could see on its own; a reply or quote is then shown only when what it points at is in `base` too.
            const res = await tx.execute(sql`
              WITH base AS (
                SELECT m.id, m.parent_message_id, m.quoted_message_id, m.author_user_id, m.body_cipher, m.body_kind, m.status, m.created_at
                  FROM message m
                  JOIN channel c ON c.organization_id = m.organization_id AND c.id = m.channel_id
                 WHERE m.organization_id = ${organizationId}
                   AND m.channel_id = ${live.channelId}
                   AND c.channel_kind::text IN (${KIND_LIST})
                   AND m.created_at >= (SELECT s.shared_from FROM message_external_share s
                                         WHERE s.organization_id = ${organizationId} AND s.id = ${live.shareId})
                   AND m.status <> 'deleted'
                   AND m.author_kind = 'user'
                   AND m.body_kind::text <> 'system'
                   AND m.urgency = 'routine'
                   AND m.urgent_recipient_user_id IS NULL
                   AND NOT (${held})
                   AND NOT EXISTS (SELECT 1 FROM message_attachment a WHERE a.organization_id = m.organization_id AND a.message_id = m.id)
                   AND NOT EXISTS (SELECT 1 FROM clinical_link l WHERE l.organization_id = m.organization_id AND l.message_id = m.id)
                   AND NOT EXISTS (SELECT 1 FROM message_entity_reference e WHERE e.organization_id = m.organization_id AND e.message_id = m.id)
                   AND NOT EXISTS (SELECT 1 FROM chart_promotion_request p WHERE p.organization_id = m.organization_id AND p.message_id = m.id)
                   AND NOT EXISTS (SELECT 1 FROM message_acknowledgment_request k WHERE k.organization_id = m.organization_id AND k.message_id = m.id)
                   AND NOT EXISTS (SELECT 1 FROM message_redaction d WHERE d.organization_id = m.organization_id AND d.message_id = m.id)
              )
              SELECT b.id AS "id", u.name AS "authorName", b.body_cipher AS "bodyCipher", b.body_kind::text AS "bodyKind",
                     b.status::text AS "status", b.created_at::text AS "createdAtText"
                FROM base b
                LEFT JOIN "user" u ON u.id = b.author_user_id
               WHERE (b.parent_message_id IS NULL OR b.parent_message_id IN (SELECT id FROM base))
                 AND (b.quoted_message_id IS NULL OR b.quoted_message_id IN (SELECT id FROM base))
                 ${cursor}
               ORDER BY b.created_at ASC, b.id ASC
               LIMIT ${limit}`);
            const rows =
              (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[]);
            return (rows as Array<Record<string, unknown>>).map((r) => ({
              id: String(r.id),
              authorName:
                r.authorName === null || r.authorName === undefined ? null : String(r.authorName),
              bodyCipher: Buffer.isBuffer(r.bodyCipher)
                ? r.bodyCipher
                : Buffer.from(String(r.bodyCipher).replace(/^\\x/, ""), "hex"),
              bodyKind: String(r.bodyKind),
              status: String(r.status),
              createdAtText: String(r.createdAtText),
            }));
          },
          async recordRead(live, messageCount, withheldCount) {
            await tx.insert(R).values({
              organizationId,
              shareId: live.shareId,
              sessionId: live.sessionId,
              messageCount,
              withheldCount,
            });
          },
        }),
      ),
  };
}

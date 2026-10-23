// M36 WP 6.6 (ADR-0096, PROPOSED), slice S1 - external partner share (migration 1180): a read-only, single-conversation, expiring grant for a
// non-workforce partner, the partner's staged bearer session, and an insert-only read trail. Names match the migration (pinned by a test); the
// lifecycle instants are set from the database clock by the guard triggers. The invite token, the session token and the verification code are
// stored as HASHES only; nothing here is a message body.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { channels } from "./channels";

export const messageExternalShares = pgTable(
  "message_external_share",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    partnerName: text("partner_name").notNull(),
    /** EXTERNAL_SHARE_PARTNER_KINDS in @chartwarden/types. */
    partnerKind: text("partner_kind").notNull(),
    /** Fixed to 'read' by CHECK in this slice (ADR-0096 D6). */
    access: text("access").notNull().default("read"),
    baaReference: text("baa_reference").notNull(),
    /** Database clock at creation, frozen: the partner never sees a message older than this. */
    sharedFrom: timestamp("shared_from", { withTimezone: true }).notNull().defaultNow(),
    /** Frozen; at most 30 days after shared_from (CHECK). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
    inviteTokenHash: text("invite_token_hash").notNull(),
    inviteRedeemedAt: timestamp("invite_redeemed_at", { withTimezone: true }),
    codeHash: text("code_hash").notNull(),
    codeAttempts: integer("code_attempts").notNull().default(0),
  },
  (t) => ({
    orgIdUnique: unique("message_external_share_org_id_unique").on(t.organizationId, t.id),
    inviteUnique: unique("message_external_share_invite_unique").on(t.inviteTokenHash),
    channelFk: foreignKey({
      name: "message_external_share_channel_fk",
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete("cascade"),
    byChannel: index("message_external_share_channel_idx").on(t.organizationId, t.channelId),
    byLive: index("message_external_share_live_idx")
      .on(t.organizationId, t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
    byCreator: index("message_external_share_created_by_idx").on(t.createdBy, t.createdAt),
    byRevoker: index("message_external_share_revoked_by_idx")
      .on(t.revokedBy)
      .where(sql`${t.revokedBy} IS NOT NULL`),
    kind: check(
      "message_external_share_kind",
      sql`${t.partnerKind} IN ('pharmacy', 'dme', 'other')`,
    ),
    access: check("message_external_share_access", sql`${t.access} = 'read'`),
    nameLen: check(
      "message_external_share_name_len",
      sql`char_length(btrim(${t.partnerName})) BETWEEN 1 AND 120`,
    ),
    baaLen: check(
      "message_external_share_baa_len",
      sql`char_length(btrim(${t.baaReference})) BETWEEN 1 AND 120`,
    ),
    expiry: check(
      "message_external_share_expiry",
      sql`${t.expiresAt} > ${t.sharedFrom} AND ${t.expiresAt} <= ${t.sharedFrom} + interval '30 days'`,
    ),
    revokePair: check(
      "message_external_share_revoke_pair",
      sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`,
    ),
    attempts: check("message_external_share_attempts", sql`${t.codeAttempts} BETWEEN 0 AND 5`),
  }),
);

export const messageExternalSessions = pgTable(
  "message_external_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    shareId: uuid("share_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** EXTERNAL_SESSION_STAGES in @chartwarden/types; enrolment -> active, once (guard). */
    stage: text("stage").notNull().default("enrolment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (t) => ({
    orgIdUnique: unique("message_external_session_org_id_unique").on(t.organizationId, t.id),
    tokenUnique: unique("message_external_session_token_unique").on(t.tokenHash),
    shareFk: foreignKey({
      name: "message_external_session_share_fk",
      columns: [t.organizationId, t.shareId],
      foreignColumns: [messageExternalShares.organizationId, messageExternalShares.id],
    }).onDelete("cascade"),
    byShare: index("message_external_session_share_idx").on(t.organizationId, t.shareId),
    stage: check("message_external_session_stage", sql`${t.stage} IN ('enrolment', 'active')`),
    stagePair: check(
      "message_external_session_stage_pair",
      sql`(${t.stage} = 'active') = (${t.activatedAt} IS NOT NULL)`,
    ),
  }),
);

export const messageExternalShareReads = pgTable(
  "message_external_share_read",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    shareId: uuid("share_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
    messageCount: integer("message_count").notNull(),
  },
  (t) => ({
    shareFk: foreignKey({
      name: "message_external_share_read_share_fk",
      columns: [t.organizationId, t.shareId],
      foreignColumns: [messageExternalShares.organizationId, messageExternalShares.id],
    }).onDelete("cascade"),
    sessionFk: foreignKey({
      name: "message_external_share_read_session_fk",
      columns: [t.organizationId, t.sessionId],
      foreignColumns: [messageExternalSessions.organizationId, messageExternalSessions.id],
    }).onDelete("cascade"),
    byShare: index("message_external_share_read_share_idx").on(
      t.organizationId,
      t.shareId,
      t.readAt,
    ),
    bySession: index("message_external_share_read_session_idx").on(t.organizationId, t.sessionId),
    count: check("message_external_share_read_count", sql`${t.messageCount} >= 0`),
  }),
);

export type MessageExternalShareRow = typeof messageExternalShares.$inferSelect;
export type MessageExternalSessionRow = typeof messageExternalSessions.$inferSelect;
export type MessageExternalShareReadRow = typeof messageExternalShareReads.$inferSelect;

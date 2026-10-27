// M36 WP 5.8 (ADR-0087, PROPOSED), slice S1 - messaging break-glass (migration 1140): a self-requested, time-limited, read-only grant on one
// channel, a mandatory post-review, and an insert-only read trail. Names match the migration (pinned by a test); granted_at / revoked_at /
// reviewed_at / read_at are set from the database clock by the guard triggers. Ids, closed codes, counts and instants, plus the two
// reviewer-only free-text columns (justification, note); never a message body.
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { channels } from "./channels";

export const messageBreakGlassGrants = pgTable(
  "message_break_glass_grant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").notNull(),
    granteeUserId: uuid("grantee_user_id")
      .notNull()
      .references(() => users.id),
    /** BREAK_GLASS_REASON_CODES in @chartwarden/types. */
    reasonCode: text("reason_code").notNull(),
    /** 20..280 characters after trimming; reviewer-only, never copied into events, alerts, logs or search. */
    justification: text("justification").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    orgIdUnique: unique("message_break_glass_grant_org_id_unique").on(t.organizationId, t.id),
    channelFk: foreignKey({
      name: "message_break_glass_grant_channel_fk",
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete("cascade"),
    oneOpen: uniqueIndex("message_break_glass_grant_one_open")
      .on(t.organizationId, t.channelId, t.granteeUserId)
      .where(sql`${t.revokedAt} IS NULL`),
    byGrantee: index("message_break_glass_grant_grantee_idx").on(
      t.organizationId,
      t.granteeUserId,
      t.expiresAt,
    ),
    byChannel: index("message_break_glass_grant_channel_idx").on(t.organizationId, t.channelId),
    byGranteeUser: index("message_break_glass_grant_grantee_user_idx").on(t.granteeUserId),
    reason: check(
      "message_break_glass_grant_reason",
      sql`${t.reasonCode} IN ('patient_safety', 'covering_colleague', 'record_correction', 'other')`,
    ),
    justification: check(
      "message_break_glass_grant_justification",
      sql`char_length(btrim(${t.justification})) BETWEEN 20 AND 280`,
    ),
    window: check("message_break_glass_grant_window", sql`${t.expiresAt} > ${t.grantedAt}`),
    maxWindow: check(
      "message_break_glass_grant_max_window",
      sql`${t.expiresAt} <= ${t.grantedAt} + interval '24 hours'`,
    ),
  }),
);

export const messageBreakGlassReviews = pgTable(
  "message_break_glass_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    grantId: uuid("grant_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** 'reviewed' | 'concern' (BREAK_GLASS_REVIEW_OUTCOMES); NULL while pending. A concern needs a note. */
    outcome: text("outcome"),
    /** Reviewer-only, at most 1000 characters. */
    note: text("note"),
  },
  (t) => ({
    grantUnique: unique("message_break_glass_review_grant_unique").on(t.organizationId, t.grantId),
    grantFk: foreignKey({
      name: "message_break_glass_review_grant_fk",
      columns: [t.organizationId, t.grantId],
      foreignColumns: [messageBreakGlassGrants.organizationId, messageBreakGlassGrants.id],
    }).onDelete("cascade"),
    pending: index("message_break_glass_review_pending_idx")
      .on(t.organizationId, t.createdAt)
      .where(sql`${t.reviewedAt} IS NULL`),
    byReviewer: index("message_break_glass_review_reviewer_idx").on(t.reviewerUserId),
    outcome: check(
      "message_break_glass_review_outcome",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('reviewed', 'concern')`,
    ),
    state: check(
      "message_break_glass_review_state",
      sql`(${t.reviewedAt} IS NULL AND ${t.reviewerUserId} IS NULL AND ${t.outcome} IS NULL AND ${t.note} IS NULL) OR (${t.reviewedAt} IS NOT NULL AND ${t.reviewerUserId} IS NOT NULL AND ${t.outcome} IS NOT NULL)`,
    ),
    concernNote: check(
      "message_break_glass_review_concern_note",
      sql`${t.outcome} IS DISTINCT FROM 'concern' OR coalesce(char_length(btrim(${t.note})), 0) > 0`,
    ),
    noteLen: check(
      "message_break_glass_review_note_len",
      sql`${t.note} IS NULL OR char_length(${t.note}) <= 1000`,
    ),
  }),
);

export const messageBreakGlassReads = pgTable(
  "message_break_glass_read",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    grantId: uuid("grant_id").notNull(),
    /** BREAK_GLASS_READ_KINDS in @chartwarden/types. */
    readKind: text("read_kind").notNull(),
    /** The thread root, attachment or other single resource read; NULL for a whole-channel or list read. */
    resourceId: uuid("resource_id"),
    itemCount: integer("item_count"),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    grantFk: foreignKey({
      name: "message_break_glass_read_grant_fk",
      columns: [t.organizationId, t.grantId],
      foreignColumns: [messageBreakGlassGrants.organizationId, messageBreakGlassGrants.id],
    }).onDelete("cascade"),
    byGrant: index("message_break_glass_read_grant_idx").on(t.organizationId, t.grantId, t.readAt),
    kind: check(
      "message_break_glass_read_kind",
      sql`${t.readKind} IN ('channel', 'messages', 'thread', 'attachment', 'search', 'ack', 'handoff', 'context')`,
    ),
    count: check(
      "message_break_glass_read_count",
      sql`${t.itemCount} IS NULL OR ${t.itemCount} >= 0`,
    ),
  }),
);

export type MessageBreakGlassGrantRow = typeof messageBreakGlassGrants.$inferSelect;
export type NewMessageBreakGlassGrantRow = typeof messageBreakGlassGrants.$inferInsert;
export type MessageBreakGlassReviewRow = typeof messageBreakGlassReviews.$inferSelect;
export type MessageBreakGlassReadRow = typeof messageBreakGlassReads.$inferSelect;

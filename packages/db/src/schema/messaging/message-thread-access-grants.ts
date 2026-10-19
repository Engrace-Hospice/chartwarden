// M36 ADR-0083 (PROPOSED), slice G1 - the audited, time-limited, one-thread read grant (migration 1132). Insert / revoke-only: the
// database guard allows one change, revoked_at NULL -> a value. Ids, a closed reason and instants only. Names match the migration
// (pinned by a test); granted_at / revoked_at are set from the database clock by the guard trigger.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { messageAckRequests } from "./message-acknowledgments";
import { messages } from "./messages";

export const messageThreadAccessGrants = pgTable(
  "message_thread_access_grant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").notNull(),
    rootMessageId: uuid("root_message_id").notNull(),
    requestId: uuid("request_id").notNull(),
    granteeUserId: uuid("grantee_user_id")
      .notNull()
      .references(() => users.id),
    /** 'escalated' | 'reassigned' | 'oncall_role_send' (THREAD_ACCESS_GRANT_REASONS in @wardenx/types). */
    reason: text("reason").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    rootFk: foreignKey({
      name: "message_thread_grant_root_fk",
      columns: [t.organizationId, t.channelId, t.rootMessageId],
      foreignColumns: [messages.organizationId, messages.channelId, messages.id],
    }).onDelete("cascade"),
    requestFk: foreignKey({
      name: "message_thread_grant_request_fk",
      columns: [t.organizationId, t.requestId],
      foreignColumns: [messageAckRequests.organizationId, messageAckRequests.id],
    }).onDelete("cascade"),
    oneLive: uniqueIndex("message_thread_grant_one_live")
      .on(t.organizationId, t.requestId, t.granteeUserId)
      .where(sql`${t.revokedAt} IS NULL`),
    byRoot: index("message_thread_grant_root_idx").on(
      t.organizationId,
      t.channelId,
      t.rootMessageId,
    ),
    byGrantee: index("message_thread_grant_grantee_idx").on(
      t.organizationId,
      t.granteeUserId,
      t.expiresAt,
    ),
    byGranteeUser: index("message_thread_grant_grantee_user_idx").on(t.granteeUserId),
    reason: check(
      "message_thread_grant_reason",
      sql`${t.reason} IN ('escalated', 'reassigned', 'oncall_role_send')`,
    ),
    window: check("message_thread_grant_window", sql`${t.expiresAt} > ${t.grantedAt}`),
  }),
);

export type MessageThreadAccessGrantRow = typeof messageThreadAccessGrants.$inferSelect;
export type NewMessageThreadAccessGrantRow = typeof messageThreadAccessGrants.$inferInsert;

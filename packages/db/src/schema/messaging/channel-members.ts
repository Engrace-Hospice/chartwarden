// @wardenx/db — `channel_member` (M36 Secure Messaging §3.3). The membership join between a
// channel and a user. M36-F04 / ADR-0010: organization_id is carried DIRECTLY (not derived
// via a subquery into `channel`) so the canonical SD-029 app.org_id RLS template applies and
// the SD-028 composite (organization_id, channel_id) index is possible. `source` records
// whether the row was auto-synced (care-team/on-call/discipline/location reconcilers, §2.5)
// or manually added. `removed_at` is the soft-delete marker — the active-row partial unique
// index keys on removed_at IS NULL. RLS + the M4 write-audit trigger land in M36-T03.
import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { channelMemberRole, channelMemberSource } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";
import { channels } from "./channels";
import { messages } from "./messages";

export const channelMembers = pgTable(
  "channel_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").notNull(), // composite FK (organization_id, channel_id) below
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: channelMemberRole("role").notNull().default("member"),
    source: channelMemberSource("source").notNull(),
    lastReadMessageId: uuid("last_read_message_id"), // composite FK (organization_id, last_read_message_id) below (1074)
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => ({
    channelOrgFk: foreignKey({
      name: "channel_member_channel_org_fk",
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete("cascade"),
    byOrgChannelIdx: index("channel_member_org_channel_idx").on(t.organizationId, t.channelId),
    // The migration (1074) uses the column-list form `ON DELETE SET NULL (last_read_message_id)` so
    // organization_id (NOT NULL) is never nulled; drizzle cannot express it, so never let drizzle-kit
    // output replace the SQL constraint with a whole-row SET NULL.
    lastReadOrgFk: foreignKey({
      name: "channel_member_last_read_org_fk",
      columns: [t.organizationId, t.lastReadMessageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("set null"),
    byOrgLastReadIdx: index("channel_member_org_last_read_idx")
      .on(t.organizationId, t.lastReadMessageId)
      .where(sql`last_read_message_id IS NOT NULL`),
    activeMembership: uniqueIndex("channel_member_active_unique")
      .on(t.channelId, t.userId)
      .where(sql`removed_at IS NULL`),
    byUser: index("channel_member_user_idx").on(t.userId).where(sql`removed_at IS NULL`),
    byChannel: index("channel_member_channel_idx").on(t.channelId).where(sql`removed_at IS NULL`),
  }),
);

export type ChannelMember = typeof channelMembers.$inferSelect;
export type NewChannelMember = typeof channelMembers.$inferInsert;

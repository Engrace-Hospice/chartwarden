// @wardenx/db — `channel_member` (M36 Secure Messaging §3.3). The membership join between a
// channel and a user. M36-F04 / ADR-0010: organization_id is carried DIRECTLY (not derived
// via a subquery into `channel`) so the canonical SD-029 app.org_id RLS template applies and
// the SD-028 composite (organization_id, channel_id) index is possible. `source` records
// whether the row was auto-synced (care-team/on-call/discipline/location reconcilers, §2.5)
// or manually added. `removed_at` is the soft-delete marker — the active-row partial unique
// index keys on removed_at IS NULL. RLS + the M4 write-audit trigger land in M36-T03.
import { sql } from "drizzle-orm";
import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { channelMemberRole, channelMemberSource } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";
import { channels } from "./channels";

export const channelMembers = pgTable(
  "channel_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: channelMemberRole("role").notNull().default("member"),
    source: channelMemberSource("source").notNull(),
    lastReadMessageId: uuid("last_read_message_id"), // soft FK (no constraint to avoid cycles)
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => ({
    activeMembership: uniqueIndex("channel_member_active_unique")
      .on(t.channelId, t.userId)
      .where(sql`removed_at IS NULL`),
    byUser: index("channel_member_user_idx").on(t.userId).where(sql`removed_at IS NULL`),
    byChannel: index("channel_member_channel_idx").on(t.channelId).where(sql`removed_at IS NULL`),
  }),
);

export type ChannelMember = typeof channelMembers.$inferSelect;
export type NewChannelMember = typeof channelMembers.$inferInsert;

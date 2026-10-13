import { sql } from "drizzle-orm";
// M36 WP 2.5 — server-side drafts: one private, encrypted draft per (user, channel, thread root). See migration 1085.
// `bodyCipher` is the tenant-DEK envelope of a JSON document ({ body, references }); never audited, never logged.
import {
  check,
  customType,
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
import { messages } from "./messages";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const messageDrafts = pgTable(
  "message_draft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentMessageId: uuid("parent_message_id"),
    bodyCipher: bytea("body_cipher").notNull(),
    revision: integer("revision").notNull().default(1),
    deviceId: text("device_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerSlotUnique: unique("message_draft_owner_slot_unique")
      .on(t.organizationId, t.userId, t.channelId, t.parentMessageId)
      .nullsNotDistinct(),
    byChannelParent: index("message_draft_org_channel_parent_idx").on(
      t.organizationId,
      t.channelId,
      t.parentMessageId,
    ),
    byUser: index("message_draft_user_idx").on(t.userId),
    channelOrgFk: foreignKey({
      name: "message_draft_channel_org_fk",
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete("cascade"),
    parentOrgChannelFk: foreignKey({
      name: "message_draft_parent_org_channel_fk",
      columns: [t.organizationId, t.channelId, t.parentMessageId],
      foreignColumns: [messages.organizationId, messages.channelId, messages.id],
    }).onDelete("cascade"),
    revisionPositive: check("message_draft_revision_positive", sql`${t.revision} >= 1`),
    deviceShape: check(
      "message_draft_device_shape",
      sql`char_length(${t.deviceId}) BETWEEN 1 AND 64`,
    ),
  }),
);

export type MessageDraft = typeof messageDrafts.$inferSelect;
export type NewMessageDraft = typeof messageDrafts.$inferInsert;

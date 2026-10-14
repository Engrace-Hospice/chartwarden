// M36 WP 2.10 - polls (migration 1093). `message_poll` is one poll per message (the question is the message body),
// `message_poll_option` its 2..10 options (label sealed at rest like a body), `message_poll_vote` one NAMED vote per
// user per poll (a change of mind is an UPDATE, audited by the write-audit trigger). Composite FKs tie every row to its
// own organisation (and the poll to the message's channel), so the database refuses a cross-tenant link.
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

// Envelope-encrypted option label, stored as PostgreSQL bytea.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const messagePolls = pgTable(
  "message_poll",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").notNull(), // composite FK below
    messageId: uuid("message_id").notNull(), // composite FK below
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageChannelFk: foreignKey({
      name: "message_poll_message_channel_fk",
      columns: [t.organizationId, t.channelId, t.messageId],
      foreignColumns: [messages.organizationId, messages.channelId, messages.id],
    }).onDelete("cascade"),
    onePollPerMessage: unique("message_poll_message_unique").on(t.organizationId, t.messageId),
    channelMessageIdx: index("message_poll_channel_message_idx").on(
      t.organizationId,
      t.channelId,
      t.messageId,
    ),
    orgIdIdUnique: unique("message_poll_org_id_id_unique").on(t.organizationId, t.id),
    closedShape: check(
      "message_poll_closed_shape",
      sql`(closed_at IS NULL) = (closed_by_user_id IS NULL)`,
    ),
  }),
);

export const messagePollOptions = pgTable(
  "message_poll_option",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    pollId: uuid("poll_id").notNull(), // composite FK below
    position: integer("position").notNull(),
    labelCipher: bytea("label_cipher").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pollFk: foreignKey({
      name: "message_poll_option_poll_fk",
      columns: [t.organizationId, t.pollId],
      foreignColumns: [messagePolls.organizationId, messagePolls.id],
    }).onDelete("cascade"),
    pollOptionUnique: unique("message_poll_option_poll_id_unique").on(
      t.organizationId,
      t.pollId,
      t.id,
    ),
    positionUnique: unique("message_poll_option_position_unique").on(
      t.organizationId,
      t.pollId,
      t.position,
    ),
    positionBounds: check("message_poll_option_position_check", sql`position BETWEEN 0 AND 9`),
  }),
);

export const messagePollVotes = pgTable(
  "message_poll_vote",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    pollId: uuid("poll_id").notNull(), // composite FK below
    optionId: uuid("option_id").notNull(), // composite FK below
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    optionFk: foreignKey({
      name: "message_poll_vote_option_fk",
      columns: [t.organizationId, t.pollId, t.optionId],
      foreignColumns: [
        messagePollOptions.organizationId,
        messagePollOptions.pollId,
        messagePollOptions.id,
      ],
    }).onDelete("cascade"),
    onePerUser: unique("message_poll_vote_unique").on(t.organizationId, t.pollId, t.userId),
    optionIdx: index("message_poll_vote_option_idx").on(t.organizationId, t.pollId, t.optionId),
  }),
);

export type MessagePollRow = typeof messagePolls.$inferSelect;
export type MessagePollOptionRow = typeof messagePollOptions.$inferSelect;
export type MessagePollVoteRow = typeof messagePollVotes.$inferSelect;
